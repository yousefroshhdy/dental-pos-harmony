# API Contracts — Honest OS

> Status: **Specified; 4 commands prototyped in the draft schema** (`api.submit_order`, `api.visit_check_in`, `api.post_inventory_adjustment`, `api.grant_role`) · Last updated: 2026-10-28

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
| `api.create_return` | `sales.return.create` | order, lines[{order_item_id, lot_id, qty, condition}], reason | `{return_id, status}` | `QTY_EXCEEDS_FULFILLED` |
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
| `api.calculate_commissions` | `perf.commission.calculate` | period | `{calc_run_id, entries, total}` | `PERIOD_LOCKED` |
| `api.approve_commission_period` | `wf.approval.decide.perf.commission` | period | `{period_id, status}` | |
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
| `POST /api/cron/outbox` | Vercel Cron (every 1–5 min) | `Authorization: Bearer $CRON_SECRET` | Claim ≤ 100 rows `FOR UPDATE SKIP LOCKED` → deliver → update status/backoff |
| `POST /api/cron/kpi-snapshot` | Vercel Cron nightly 02:00 Cairo | `CRON_SECRET` | Calls `api.snapshot_kpis(period)` (or pg_cron directly) |
| `POST /api/cron/overdue-scan` | daily 07:00 Cairo | `CRON_SECRET` | Overdue invoices → collection tasks + outbox `invoice.overdue` |

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
