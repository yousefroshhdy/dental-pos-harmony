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
| Tracking (D-14) | `acknowledge_tracking_notice(version)`, `start_shift(…)`, `end_shift(…)`, `record_location_pings(jsonb)`, `report_device_status(shift, payload)`; service: `tracking_auto_close()`, `tracking_purge()` | `my_tracking_status()`, `tracking_day(employee, day)`, `tracking_team_day(day)`, `v_tracking_day_summaries`, `v_tracking_health` | `/api/cron/tracking` daily |

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

**Commission rate editor and rep statement** (Phase P step 7, `20261125000400`; suite 58). All four commands need `perf.commission_plan.manage` company-wide (held by no role: owners only; MFA-gated) and take the commission engine lock. Every row change is audited.

| Command | Answer | Errors / notes |
|---------|--------|----------------|
| `create_commission_plan(p_code text, p_name text)` | `{plan_id, code, status:'draft', replayed}` | code `^[A-Z0-9][A-Z0-9_-]{1,39}$` (upper-cased), name 3–120. Same code and name: replay. Same code, other name: `DUPLICATE`. Basis is always `collected`. |
| `set_commission_rate(p_plan_id uuid, p_target text, p_target_id uuid, p_rate_pct numeric, p_effective_from date, p_note text = null, p_idempotency_key text = null)` | `{rule_id, plan_id, target, target_id, rate_pct, effective_from, closed, voided, replayed}` | `p_target` is `default` (no id), `brand`, `category` or `variant`. `p_rate_pct` 0–100, 2 decimals; NULL = no rate from that day. Append-only: the target's rate in force that day gets `effective_to = day − 1`; a rate of the target that starts on or after the day is voided. `p_effective_from` ≥ first day of the oldest open month (`PERIOD_CLOSED`), ≤ today + 366. Retired plan: `INVALID_STATE`. Unknown target: `NOT_FOUND`. Same key or same rate already in force from that day: replay; key reused for another rate: `IDEMPOTENCY_CONFLICT`. Event `commission.rate_changed`. |
| `activate_commission_plan(p_plan_id uuid, p_effective_from date, p_assign_sales_reps boolean = true)` | `{plan_id, code, status:'active', effective_from, assigned, replayed}` | draft only (`INVALID_STATE`); needs a rate (`VALIDATION`); start not in a closed month (`PERIOD_CLOSED`). With `p_assign_sales_reps`, each active employee holding the `sales_rep` role and no assignment that day gets `perf.employee_commission_plans` from that day. Event `commission.plan_activated`. |
| `deactivate_commission_plan(p_plan_id uuid, p_effective_to date, p_reason text)` | `{plan_id, code, status:'retired', effective_to, assignments_ended, assignments_cancelled, replayed}` | active only; `REASON_REQUIRED`; the end day ≥ day before the oldest open month and ≥ the plan's start − 1. The plan still applies up to and including that day. Assignments end that day; later-starting ones are cancelled. Event `commission.plan_retired`. |
| `commission_unrated(p_plan_id uuid, p_day date = null)` (read) | rows `{variant_id, sku, variant_name_en, product_id, product_code, product_name_en, product_name_ar, brand_id, brand_code, brand_name, category_id, category_code, category_name_en, category_name_ar}` | `perf.commission_plan.read` or `.manage`. Active variants of active/draft products with no rate in the plan on the day (default today): they earn 0. At most 2000 rows. |

Views (`security_invoker`): `v_commission_plans` (plan + `is_default`, `current_rate_count`, `assigned_count`) and `v_commission_plan_rules` (every rate row with `target_type`, target code and names, `state`: `current`, `scheduled`, `ended`, `void`), both for `perf.commission_plan.read`/`.manage`. `v_commission_statement_totals`: one row per (month, employee) the caller may read (`perf.commission.read` scope): `collected_gross` (collections, incl. VAT), `vat_amount`, `commissionable` (excl. VAT), `unrated_base` (commissionable at 0 %), `commission`, `clawbacks` (returns within the window, reversals, bounces, net of the re-allocation after a return), `clawback_base`, `adjustments`, `net`, `entry_count`. Guard errors on direct writes: `COMMISSION_RULE_IMMUTABLE`, `COMMISSION_PLAN_IMMUTABLE`, `PERIOD_CLOSED`.

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

**Tracking health** (`20261125000500`; suite 59, Phase P step 5).
- `report_device_status(p_shift_id uuid, p_payload jsonb) → jsonb`: needs `field.shift.start`; the shift must be the caller's own **open** shift (else `NO_OPEN_SHIFT`, P0001; an overdue shift is closed first). `p_payload` is a JSON object of at most 1024 bytes with only these keys, each optional (missing = null): `source` (`pwa`/`native`), `permission` (`granted`/`denied`/`prompt`/`services_off`/`unknown`), `app_version` and `web_build` (`^[0-9A-Za-z._+-]{1,40}$`), `battery_saver` (boolean), `pending_points` (integer 0–100000). Any other key or type: `VALIDATION`. A report replaces the shift's last one and answers `{status: "recorded", shift_id, reported_at, report_count}`; within 60 s of the last one it stores nothing and answers `{status: "rate_limited", shift_id, reported_at, retry_after_s}` (not an error). No client ref: it is a snapshot, sent online only (never queued). The server action adds `web_build` (Vercel commit, 12 characters) itself.
- `v_tracking_health` (security_invoker, read-only): one row per trackable employee in the caller's D-14 scope (self; `field.tracking.read` own/team/territory; global). Columns: `employee_id`, `employee_no`, `full_name_en`, `full_name_ar`, `shift_id`, `shift_status`, `shift_open`, `shift_started_at`, `shift_ended_at`, `shift_since` (start if open, end if closed), `last_point_at`, `last_point_received_at`, `last_point_source`, `shift_last_received_at`, `shift_point_count`, `device_reported_at`, `device_source`, `device_permission`, `device_app_version`, `device_web_build`, `device_battery_saver`, `device_pending_points`, `checked_at` (server now), `needs_attention` (open shift and nothing arrived for more than 15 minutes, counted from the start when no point arrived). No coordinates.

**New error codes:** `MFA_REQUIRED`, `RATE_LIMITED`, `QTY_EXCEEDS_RETURNABLE`, `WAREHOUSE_NOT_QUARANTINE`, `CREDIT_QTY_EXCEEDED`, `WRITE_OFF_PENDING`, `ALREADY_COMMITTED`, `ALREADY_IMPORTED`, `PREVIOUS_PERIOD_OPEN`, `PERIOD_NOT_ENDED`, `PERIOD_CLOSED`, `SELF_ADJUSTMENT`, `SETTING_NOT_WHITELISTED`, `SETTING_READ_ONLY`, `SETTING_OUT_OF_RANGE`, `SETTING_SECRET_REFUSED`, `MANAGER_CYCLE`, `TERRITORY_TOO_DEEP`, `TERRITORY_CYCLE`, `TERRITORY_HAS_CHILDREN`, `NOT_ASSIGNED`, `PAST_DATE`, `DAILY_CAP`, `TIMEOUT`, `INVALID_CONDITION`, `CATCH_ALL_REQUIRED`, `RULE_IN_USE`.

### 1c. Phase P step 6: pricing, offers and VAT (migrations `20261125000200`, `20261125000210`; suite 56)

Pricing rules (all in `sales.price_order`, documented at the top of `20261125000210`): prices exclude VAT; VAT per line at the product's rate; bonus lines 0; offers (per-line net or package price spread by list value, capped at list); net price → exact amount and % (2 decimals, half-up); invoice discount spread by net value, last line takes the rounding.

**Orders (changed, same signatures):**
- `save_order_draft(p_order_id, p_customer_id, p_lines, p_notes, p_visit_id, p_version, p_employee_id)`: `p_lines` is the old array **or** `{"lines": [...], "invoice_discount_amount": n}` / `{"lines": [...], "invoice_discount_pct": n}` (one of the two). A line is a product line `{variant_id, quantity, requested_discount_pct? | net_unit_price?, is_bonus?}` (net price > 0, 2 decimals; a bonus line takes neither) or an offer line `{offer_id, quantity?}` (packages, default 1; each offer once) that the server expands into the offer's items. Replay keys and fingerprint are unchanged (the request as sent), so payloads queued before this change replay as before. The answer adds `invoice_discount_amount`, `invoice_discount_pct`, and per line `is_bonus`, `offer_id`, `line_discount`, `manual_discount_pct`, `line_tax`.
- `submit_order(p_order_id)`: re-checks every offer on the order (validity, targeting, composition) and raises `OFFER_EXPIRED`, `OFFER_NOT_STARTED`, `OFFER_INACTIVE`, `OFFER_NOT_ELIGIBLE`, `OFFER_CHANGED` (P0001). Discount authority per `sales.discount.limit_mode` (DECISIONS 2026-11-25). New reason `free item outside an offer`. The request payload adds `limit_mode`, `owner_required`, `free_items`.
- `preview_order(p_customer_id, p_lines, p_employee_id = null) → jsonb`: the full server pricing of a would-be draft, nothing saved: `subtotal, discount_total, tax_total, total, prices_include_vat (false), invoice_discount_total, lines[], vat_groups[{rate, taxable, vat}], approval{needed, reasons[], owner_required, mode, limit_pct, …}` (the credit check runs only at submit). Needs `sales.order.create`; same validation errors as a save.
- `issue_invoice`: copies `is_bonus` to the invoice line; a partial invoice of a net-price, offer or invoice-discount line takes its discount pro rata from the line's amount. VAT is the rate stored on the order line.
- New errors: `NET_PRICE_ABOVE_LIST`, `INVOICE_DISCOUNT_TOO_LARGE` (P0001).

**Offers (new, `sales.offer.manage` at scope `all`; owner implicitly):**
- `upsert_offer(p_offer_id, p_code, p_name_en, p_name_ar, p_pricing_mode 'package'|'per_line', p_package_price, p_valid_from date, p_valid_to date, p_items jsonb, p_customer_ids uuid[] = null, p_target_tags text[] = null, p_description = null, p_expected_version = null) → {offer_id, code, version, created}`. Items `[{variant_id, quantity, is_bonus?, net_unit_price?}]`, 1–50, per package; a package has no per-line prices, a per-line offer needs one on every paid line, at least one paid line, each variant once per bonus flag. Replaces items and targets. Errors `VALIDATION`, `NOT_FOUND`, `DUPLICATE_CODE`, `CONFLICT` (stale version), `PERMISSION_DENIED`.
- `set_offer_active(p_offer_id, p_active) → {offer_id, is_active, changed, version}`.
- `eligible_offers(p_customer_id) → jsonb[]`: offers usable today for a customer in the caller's CRM scope, with items and indicative prices. Needs `sales.order.create`.
- Views: `v_offers` (with `is_current`, item counts, `is_targeted`), `v_offer_items`, `v_offer_customers` (a target only when the customer is visible).

**VAT (new):** `set_product_vat_rate(p_product_id, p_vat_rate_pct, p_reason = null) → {product_id, vat_rate_pct, changed}`: owner only (`OWNER_ONLY`, 42501), 0–100 with 2 decimals.

**Views (columns appended):** `v_orders` + `invoice_discount_amount`, `invoice_discount_pct`; `v_order_lines` + `is_bonus`, `offer_id`, `offer_code`, `offer_packages`, `requested_net_price`, `invoice_discount_share`, `manual_discount_pct`; `v_invoice_lines` + `is_bonus`.

**Outbox:** `offer.created`, `offer.updated`, `product.vat_changed`.

**New outbox events:** `import.committed`; `return.requested`, `return.approved`, `return.rejected`, `return.received`, `return.credited`, `return.cancelled`; `commission.period_closed`, `commission.adjusted`; `invoice.written_off`; `setting.updated`; `employee.updated`, `employee.status_changed`, `employee.territory_assigned`, `employee.territory_ended`; `territory.created`, `.renamed`, `.moved`, `.deactivated`, `.reactivated`, `.coverage_changed`; `field.visits_planned`, `field.visit_unplanned`; `approval.escalated`. `credit_note.issued` gains `customer_credit` and `applied_to_invoice`.

### 1b-1. Phase P step 1: setup and real data (migrations `20261125000100`, `…000110`, 2026-11-25)

Implemented and Tested (suite 55; suites 34 and 47 unchanged and passing); nothing Verified.

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `create_customer(…)` (same signature) | `crm.customer.create` + scope (unchanged) | as before; `warnings` gains `{code:'PHONE_MISSING'}` when created without a phone | `p_phone_primary` is now **optional** (decision A: most migrated customers have none). A phone that is given must still be valid; the duplicate-phone rule applies only to a phone. `customer.created` payload gains `phone_missing`. |
| `set_employee_base_location(p_employee_id uuid, p_address text, p_lat numeric, p_lng numeric, p_source text = 'manual', p_lead_radius_km numeric = null)` | `core.employee.manage` + employee scope; only an owner edits an owner's record; nobody but an owner changes their own base (`SELF_GRANT_FORBIDDEN`) | `{employee_id, has_base_location, source, lead_radius_km, changed}` | point inside Egypt (21.5–32 N, 24.5–37.5 E), lat and lng together, source `geocoded` / `manual`, radius 0.5–50 km (default 5, decision E). All null = clear. A real change writes `employee.base_location_changed` `{employee_id, has_base_location, lead_radius_km, source}` (no coordinates, no address). Audited by `trg_audit` on `core.employees`. |
| `create_warehouse(p_warehouse_id uuid, p_code text, p_name text, p_kind text = 'main')` | `inventory.warehouse.manage` at `all` (new; owner only by default) | `{warehouse_id, code, kind, created}` | client-generated id: same id + code replays (`created:false`); `DUPLICATE_CODE`, `CONFLICT` (id reused for another code), `VALIDATION`. `allow_negative` is always false. Event `inventory.warehouse_created`. |
| `setup_overview()` | owner only (`OWNER_ONLY`, 42501) | counts for the /admin/setup checklist: warehouses, territories with coverage, employees and logins, role holders, reps with a base point, customers and `customers_phone_missing`, variants, DEFAULT prices, stock units, opening AR entries, committed imports per kind | no names, phones or amounts |
| `authorize_sign_in_link(p_employee_id uuid)` | `admin.user.create` **and** owner (`OWNER_ONLY`) | `{employee_id, user_id, email, mode}`; `mode` = `invite` (no login yet) or `magiclink` | the database check before the server asks Supabase Auth (service role) for a one-time link. Refuses: no e-mail (`VALIDATION`), employee not active / login not active / yourself (`INVALID_STATE`), an owner login (`PERMISSION_DENIED`). Writes security event `sign_in_link_issued` (warning). The link is never stored or logged. |

**Imports.** New optional columns (appended; required columns unchanged): customers `legacy_ref` (old-system account number, kept in `integration.external_refs`, provider `legacy_pos`); customer_prices and opening_ar `customer_legacy_ref`; opening_stock `cost_unknown` (yes/no).
- customers: an empty `phone_primary` is no longer an error; the row is created "phone missing". New row errors `invalid:legacy_ref`, `exists:legacy_ref`, `duplicate_in_file:legacy_ref`. Result gains `phone_missing`, `legacy_refs` (only when non-zero).
- customer_prices: a row with no customer (customer_no, customer_phone, customer_legacy_ref all empty) prices a **standard** list such as `DEFAULT` (the base list of `sales.resolve_list_price`); a new code becomes a standard list and nobody is assigned. New row errors `inconsistent:price_list_code` (one code with and without a customer), `wrong_kind:price_list_code` (a customer row on DEFAULT or a standard list; a base row on a customer list), `invalid:valid_from` (a new DEFAULT list starting in the future). Result shape unchanged.
- opening_stock: `cost_unknown = yes` stores the cost as NULL (never 0); `inconsistent:unit_cost` if a cost is also given; `invalid:cost_unknown`. An empty cost without the flag is still `required:unit_cost` when the catalogue has none. Result gains `cost_unknown_lines` (only when non-zero).
- opening_ar: customers can be named by `customer_legacy_ref`; `unknown:` / `invalid:` / `mismatch:customer_legacy_ref`.
- `create_goods_receipt`: item key `cost_unknown` (boolean). `true` = NULL cost, allowed only for a caller with `admin.import.run` company-wide (opening stock); with a `unit_cost` too it is `VALIDATION`. `inventory.goods_receipt_items.unit_cost` is nullable.
- The upload screen can fill a batch default for empty `governorate_code` cells (customers only) before staging.

**Views:** `v_customer_data_gaps` (customer_id, customer_no, display_name, lifecycle_stage, source, governorate_code, city, territory_id, `phone_missing`, `location_missing`, primary_rep_employee_id, created_at; only customers with a gap; caller's CRM RLS), `v_employee_base_locations` (employee base point and lead radius; own row or `core.employee.read` scope).

**New outbox events:** `employee.base_location_changed`, `inventory.warehouse_created`.

### 1b-2. Phase P: the old-system workbook from the browser (migration `20261126000300`, 2026-11-26)

Implemented and Tested (DB suite 62, unit `legacy-browser-import`, `legacy-convert`); nothing Verified. Every command needs `admin.import.run` at scope `all` (MFA-gated) **and** the owner role (`OWNER_ONLY`, 42501). No new permission.

| Command | Answer | Errors / notes |
|---------|--------|----------------|
| `legacy_import_check()` | `{allowed: true, open_session_id}` | The gate the server calls **before** it parses an uploaded workbook. |
| `legacy_import_start(p_idempotency_key text, p_file_name text, p_file_sha256 text, p_summary jsonb, p_negative_stock jsonb, p_credits_mode text = 'hold', p_batches jsonb)` | `{session_id, status:'open', steps:[{step_no, kind, batch_id, row_count}], replayed}` | Records the session and stages one batch per step through `api.import_create_batch` (key `<key>:<step>`), all in one transaction. `p_batches` = `{customers, products, customer_prices, opening_stock, opening_ar}` arrays of staging rows (as the /imports upload builds them); an empty array = nothing to import (no batch). `p_negative_stock` = `[{sku, name, quantity < 0, decision: zero\|skip}]`. Refuses: `LEGACY_DECISION` (a skipped item in products, prices or stock; a "fixed to 0" item in stock or missing from products; a negative opening-AR amount while credits are held), `VALIDATION` (bad decision, unknown kind key, nothing to import, summary over 32,000 characters), `INVALID_STATE` (another session is open), `CONFLICT` (key reused with another payload). Replay with the same key and payload answers `replayed:true`. Security event `legacy_import_started` (counts only). |
| `legacy_import_restage(p_session_id uuid, p_step int, p_rows jsonb, p_idempotency_key text)` | `{session_id, step_no, batch_id, replayed}` | Only the current step (every earlier step committed or empty; `LEGACY_ORDER`, `ALREADY_COMMITTED`). The old batch is discarded (`api.import_discard`) and kept in `replaced_batch_ids`; the session's decisions are re-checked against the new rows (`LEGACY_DECISION`). |
| `legacy_import_abandon(p_session_id uuid)` | `{session_id, status:'abandoned', batches_discarded, replayed}` | Discards the uncommitted batches; committed steps stay. `INVALID_STATE` on a completed session. |

**Step order on the existing commands.** A trigger on `import.batches` refuses `api.import_validate` (dry run) and `api.import_commit` on a session's batch until every earlier step committed: `LEGACY_ORDER` (P0001), whichever screen calls. Order: 1 customers → 2 products → 3 customer_prices → 4 opening_stock → 5 opening_ar. The last commit sets the session `completed`.

**Views** (security_invoker; owner + `admin.import.run`): `v_legacy_import_sessions` (id, status, file_name, file_sha256, summary, credits_mode, negative_stock, created_by + names, created_at, completed_at, abandoned_at), `v_legacy_import_steps` (session_id, step_no, kind, batch_id, restaged_count, batch_status, row/valid/error/committed counts, result, failure, failure_row_no, validated_at, committed_at), `v_legacy_import_quality` (session_id, issue `phone_missing` \| `location_missing` \| `cost_unknown`, entity_type, entity_id, customer_id, product_id, code, label: the session's customers without a phone or pin, and the items it stocked with an unknown cost while no catalogue cost exists; the cost rows need `catalog.cost.read`).

**HTTP:** `POST /api/legacy-import` (multipart, route handler, same origin only). Fields: `file` (.xlsx ≤ 4 MB), `mode` = `analyze` (`governorate_code`, `warehouse_code`) → `{ok, mode, analysis}` (reconciliation rows, negative-stock items, credits count and total, rows per step; nothing stored) · `start` (+ `idempotency_key`, `decisions` JSON `{sku: zero|skip}`, `credits_mode`) → `{ok, mode, sessionId}` · `restage` (`session_id`, `step`, `idempotency_key`) → `{ok, mode, sessionId}`. Errors `{ok:false, code, messageKey, requestId, problem?}`; `problem` ∈ `no_file`, `not_xlsx`, `too_large`, `not_zip`, `zip_bomb`, `too_many_rows`, `too_many_sheets`, `unreadable`, `missing_sheets`, `bad_request`, `bad_origin`, `decisions_incomplete`, `new_negative_items`, `file_rejected`. 403 for a cross-origin post, `PERMISSION_DENIED`, `OWNER_ONLY`, `MFA_REQUIRED`; 413 above the size cap.

**Server side (no DB command):** `src/lib/maps/geocode.ts` (server-only) calls the Google Geocoding API with `GOOGLE_MAPS_SERVER_KEY` (region `eg`, `components=country:EG`, language `ar`); without a key it answers `not_configured`. Logins on /admin/setup: `authorize_sign_in_link` → Auth admin `generateLink` (`invite` or `magiclink`) → `register_user` → `assign_employee_territory` → `grant_role`; the owner copies the link `/<locale>/auth/confirm?token_hash=…&type=…`.

### 1b-3. Phase P: the owner sets an unknown lot cost once (migration `20261126000400`, 2026-11-26; suite 63)

Implemented and Tested (DB suite 63, unit `inventory-lot-cost`, verification line OWN-20 on the local stack); nothing Verified. Owner decision 2026-11-24 (DECISIONS Part C).

| Command | Answer | Errors / notes |
|---------|--------|----------------|
| `set_lot_cost(p_lot_id uuid, p_unit_cost numeric, p_reason text, p_idempotency_key uuid)` | `{lot_id, variant_id, unit_cost, cost_status:'set', set_at, replayed}` | `authz.require('inventory.lot.set_cost')` (MFA-gated, granted to no role) then the owner role (`OWNER_ONLY`, 42501). `VALIDATION` (P0001): key missing, cost NULL / ≤ 0 / more than 2 decimals / above 999,999,999,999.99, reason not 3–500 characters after trimming. `NOT_FOUND` (P0002): no such lot. The lot row is locked (`for update`). `COST_ALREADY_SET` (P0001): the lot already has a set cost (unless the same key **and** value: then the first answer with `replayed:true`), or it has no units received with an unknown cost (every receipt carried a cost). `CONFLICT` (P0001): the key was used for another lot. Stores one row in `inventory.lot_costs` (append-only, audited with the reason). Past movements and receipt lines are **not** back-filled. |

**View** (security_invoker): `v_lot_costs`: one row per received lot: `lot_id, variant_id, sku, variant_name, product_id, lot_no, expiry_date, cost_status` (`unknown` = a receipt brought units in without a cost and none was set · `set` = the owner's cost · `known` = every receipt had a cost), `unit_cost` (the set cost, the latest receipt cost when known, NULL when unknown), `received_qty, cost_set_at, cost_set_by`. Rows only for `catalog.cost.read` holders with company-wide `inventory.movement.read` (owner, inventory manager); reps and finance get none. `v_legacy_import_quality` is restated: a `cost_unknown` item also leaves the list once none of its lots has unknown-cost units left.

**Outbox:** `inventory.lot_cost_set` (aggregate `inventory.lot`; `{lot_id, variant_id, sku, lot_no}`, no amount).

**Screen:** `/inventory/stock/<variant>`: a **Unit cost** column for cost readers ("Cost unknown" badge or the amount); the owner gets **Set cost** (bottom sheet: unit cost in EGP and a reason) on an unknown-cost lot, through the server action `setLotCost` with a page-generated key. The legacy import's "items without cost" rows link there.

### 1c. Phase P step 3: Google Maps (migrations `20261125000300`, `…000310`; suite 57)

Implemented and Tested (DB suite 57, unit tests); nothing Verified. Same conventions as 1b.

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `decide_customer_location_proposal(p_proposal_id uuid, p_approve boolean, p_note text = null)` | `crm.customer_location.verify` with the customer in scope (`authz.customer_in_scope`) | `{proposal_id, customer_id, status: approved\|rejected, latitude, longitude (approve only), replayed}` | Approve: the proposal becomes the clinic's verified location (`crm.customers.latitude/longitude`, `location_verified = true`, version + 1); every other pending proposal for the customer becomes `superseded`. `ALREADY_PINNED` (customer has a location: set it directly), `LOCATION_INACCURATE` (accuracy missing or worse than `field.max_accuracy_m`), `INVALID_STATE` (archived customer, or the proposal is decided/superseded). Reject: `REASON_REQUIRED`. The same decision again replays. Timeline note, rep notified (`customer.location_proposal_decided`), event `customer.location_proposal_decided`. |
| `tracking_day_visit_fixes(p_employee_id uuid, p_day date)` | the day's tracking scope, as `tracking_day` (own, or `field.tracking.read` covering the rep); rows only with `field.location.read` covering the rep (or own), otherwise an empty set | `visit_id, customer_id, event_type, latitude, longitude, accuracy_m, captured_at` for the Cairo day | `PERMISSION_DENIED`, `VALIDATION`. Read-only (stable). |

Unchanged commands, new behaviour:
- `visit_check_in` at a customer with no location (still allowed, `verification_status = 'no_customer_location'`): when the check-in has a fix inside Egypt, a trigger on `field.location_events` records a **pending location proposal** (one per visit; a replay adds nothing), a timeline note and event `customer.location_proposed`. The visit verdict is unchanged; the proposal never pins the clinic by itself.
- `set_customer_location` (office users: address search or a dropped pin on the customer map) supersedes the customer's pending proposals.

Views (all `security_invoker`):
- `v_customer_map`: live customers (`archived_at is null`) with `latitude, longitude, location_verified, lifecycle_stage, territory_*, primary_rep_*`, `is_overdue`, `overdue_amount`, `max_days_overdue` (NULL = masked without `crm.customer_balance.read`, like `v_customers.balance`) and `last_visit_at/_on` (visits the caller may read). Customer RLS applies.
- `v_team_last_location`: one row per rep on an **open** shift that is not past `tracking.max_shift_hours`: the latest usable ping (not `low_accuracy`, `impossible_travel`, `duplicate_fix`), else the start-of-day fix (`point_source`). Tracking RLS applies (own, or `field.tracking.read` scope). Nothing outside an open shift (D-14).
- `v_customer_location_proposals`: proposals with customer, proposer and decider names. RLS: the proposer, or `crm.customer_location.verify` covering the customer.

**New error codes:** `ALREADY_PINNED`, `LOCATION_INACCURATE`. **New outbox events:** `customer.location_proposed` `{proposal_id, customer_id, visit_id, employee_id, accuracy_m}` and `customer.location_proposal_decided` `{proposal_id, customer_id, visit_id, employee_id, decision}` (no coordinates, rule 1 of §5).

### 1d. Phase P step 4: leads around each rep (migration `20261126000100`; suite 60)

Implemented and Tested (DB suite 60, unit tests with fetch mocked); nothing Verified, no live Google call made. A lead stores only the Google place id and HONEST's own data (docs/DECISIONS.md, 2026-11-26).

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `set_lead_status(p_lead_id, p_status)` | `crm.lead.work`, lead's rep in scope | `{lead_id, status, replayed}` | `new`, `visited`, `not_interested` only; `INVALID_STATE` once prospect/customer; leaving `new` clears the plan |
| `set_lead_notes(p_lead_id, p_notes)` | `crm.lead.work` | `{lead_id, changed}` | ≤ 2000 characters; empty clears |
| `plan_lead_visit(p_lead_id, p_date)` / `unplan_lead_visit(p_lead_id)` | `field.visit.plan` over the rep + `crm.lead.work` | `{lead_id, planned_for, replayed}` | `PAST_DATE`, `DAILY_CAP` (`planning.daily_visit_cap` counts visits **and** planned leads), more than a year ahead `VALIDATION`; same date again is a replay |
| `convert_lead(p_lead_id, p_doctor_name, p_clinic_name, p_phone, p_specialty_code, p_governorate_code, p_city, p_notes, p_client_ref)` | `crm.lead.work` + `crm.customer.create` (inside `create_customer`) | `{lead_id, customer_id, customer_no, status: 'prospect', warnings, replayed}` | First visit: customer at stage `prospect`, owned by the lead's rep, `google_place_id` linked; every `create_customer` rule and error (`VALIDATION`, `DUPLICATE_CUSTOMER`, `PHONE_MISSING` warning); `ALREADY_CUSTOMER`; a converted lead answers its customer (`replayed`) |
| `lead_details_allowance(p_requested int)` | `crm.lead.read` | int (0…requested) | Before live Place Details: grants what the monthly budget and the 300-per-user-day limit allow and counts it as spent |
| `reassign_leads(p_lead_ids uuid[], p_employee_id, p_reason)` | `crm.lead.assign` over the current and the new rep | `{employee_id, moved, skipped}` | `REASON_REQUIRED`, `INVALID_STATE` for converted leads (customer reassignment has its workflow), out-of-scope lead `NOT_FOUND`; plan and distance cleared; new rep notified |
| `request_lead_discovery(p_employee_id)` | owner | `{run_id, employee_id, status: 'queued'}` | `OWNER_ONLY`, `NO_BASE_LOCATION`; refreshes the one waiting run |
| `lead_usage()` | owner | `{today_requests, month_run_cost_usd, month_detail_requests, month_detail_cost_usd, daily_request_cap, monthly_budget_usd, unit_cost_usd, run_request_limit, queued_runs}` | `OWNER_ONLY` |

Restated: `plan_visits` (only its daily-cap count changes, see above). Unchanged and used: `set_employee_base_location` (its base or radius change now queues a run through a trigger on `core.employees`), `create_customer`, `visit_check_in` (the first check-in at the new prospect proposes the pin, §1c).

Service (service role only): `service.leads_claim_run(p_run_id = null, p_key_configured)` → `{status: none | cancelled | not_configured | refused (reason daily_cap|monthly_budget) | claimed (run_id, employee_id, center{lat,lng}, radius_m, max_requests)}`; `service.leads_finish_run(run, 'done'|'failed', nearby, text, truncated, error_code, places[{place_id, distance_m, lat, lng}])` (lat/lng used for the 50 m customer check only, never stored); `service.leads_daily()` → `{distances_cleared, refresh_queued}`.

Views (`security_invoker`; RLS on `crm.leads` / `crm.lead_discovery_runs`: own for a rep, the team for a manager, everyone for a global holder): `v_leads` (place id, rep, status, distance, first/last seen, `in_latest_run`, notes, linked customer, `planned_for`, `planned_today`), `v_lead_discovery_runs` (counts and cost, no coordinates), `v_lead_stats` (per rep: totals per status, `planned_today`, `visited_pct` = visited+prospect+customer, `converted_pct` = prospect+customer, last run).

Settings (owner only): `leads.daily_request_cap` (200), `leads.monthly_budget_usd` (20). **Outbox events:** `crm.lead_discovery_finished {run_id, employee_id, status, requests, leads_new, truncated}`, `crm.lead_status_changed`, `crm.lead_converted {lead_id, employee_id, customer_id, customer_no}`, `crm.leads_reassigned {employee_id, count, reason}`, plus `customer.stage_changed` on conversion. **Notifications:** `leads.discovered`, `leads.assigned`. **New error codes:** `NO_BASE_LOCATION`, `ALREADY_CUSTOMER` (`DAILY_CAP`, `PAST_DATE` as in planning).

**Server side:** `src/lib/places/` (server-only Places API (New) client, grid, discovery); `src/modules/leads/discovery.ts` (the job). Live details: `src/modules/leads/queries.ts` `loadLeadDetails` (allowance first, then Place Details with the field mask; nothing stored).
### 1e. Phase P step 2b: Today and CRM redesign (migration `20261126000200`; suite 61)

No new command. One read view (`security_invoker`, select for `authenticated` only):
- `v_customer_list`: one row per live customer (`archived_at is null`), built on `v_customers` so the same customer RLS and balance masking apply. Columns: the list columns of `v_customers` (`id, customer_no, kind, display_name, doctor_name, clinic_name, specialty_code, lifecycle_stage, source, phone_primary, phone_secondary, city, governorate_code, territory_*, primary_rep_*, latitude, longitude, location_verified, balance, created_at, updated_at`) plus `phone_missing` and `location_missing` (same rules as `v_customer_data_gaps`) and `is_overdue`, `overdue_amount`, `max_days_overdue` (same rule as `v_customer_map`; NULL when the balance is masked, so a masked row never matches an "overdue" filter). The customers list filters on these with search, stage, territory, specialty and rep, and pages and counts on the server (`?q=&stage=&territory=&specialty=&rep=&overdue=1&phone=missing&location=missing&sort=-balance&page=2`; sortable: `display_name`, `customer_no`, `created_at`, `balance`).

Screens, existing commands:
- Customer create form: the phone is optional; `create_customer` then answers `warnings: [{code: 'PHONE_MISSING'}]` and the customer page opens with `?created=1&warn=phone_missing` and an "add phone" action.
- "Add phone" (customer page, unplanned check-in list, open visit page): `update_customer(p_customer_id, p_version, {"phone_primary": …})`, permission `crm.customer.update` in scope. A saved phone cannot be removed (`VALIDATION`, shown as `PHONE_REQUIRED` on the edit form); a phone already on another customer is `DUPLICATE_CUSTOMER`; a stale version is `CONFLICT`.
- Customer page tabs read `v_visits` (`field.visit.read`), `v_orders` (`sales.order.read`) and `v_invoices` (`finance.invoice.read`) filtered by `customer_id`, latest 20 each; RLS decides the rows.

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
| `GET\|POST /api/cron/leads` | `13 2 * * *` UTC (daily: Hobby limit) | `CRON_SECRET` | `service.leads_daily()` (clear lead distances older than 30 days, queue monthly refresh runs), then the queued discovery runs within the cost caps for ~45 s (`service.leads_claim_run` → Places API (New) with `GOOGLE_MAPS_SERVER_KEY` → `service.leads_finish_run`). Without the key every queued run ends `not_configured`. Returns counts only |
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
