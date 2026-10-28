# Integrations & Automation Blueprint — Honest OS

> Status: **Designed; nothing connected.** No credential or API access is assumed (U-06). Each integration has a **verification gate** that must pass before build. · Last updated: 2026-10-28

---

## 1. Principles

1. **Critical transactions never run inside Make.com/n8n.** Prices, stock, invoices, payments, allocations, commissions and permissions are Postgres commands. Automations only **react** to committed events or **deliver** messages.
2. **Transactional outbox.** A business command writes its event to `integration.outbox` in the same transaction. The dispatcher (`/api/cron/outbox`) delivers it. No event without a commit, and no commit without its event.
3. **Inbound = store first, process second.** Verify the signature, persist the raw payload with a unique external id, then process idempotently.
4. **Every external system has a direction:** source of truth, receiver only, or authoritative for a narrow fact (Paymob for card payment status, ETA for e-invoice validity).
5. **Swappable consumers.** Make.com scenarios subscribe to signed HTTP webhooks. Moving a scenario to n8n or to code changes only the target URL.

## 2. Platform roles

| Platform | Direction | Authoritative for | Verification gate (before build) |
|----------|-----------|-------------------|----------------------------------|
| **Make.com** | Receives events; writes only to Gmail/Sheets/Slack-like outputs. **Never writes to Honest OS tables.** | nothing | Organisation account owned by Honest®, plan with enough operations, team member access |
| **WhatsApp Business Platform (Cloud API)** | Honest OS → customers/staff (templates); inbound replies/status → Honest OS | delivery status | Meta Business Manager verified; WABA + phone number registered; templates approved (utility category for transactional) |
| **Paymob** | Paymob → Honest OS (webhooks); Honest OS → Paymob (payment links/intentions) | online payment status | Merchant account, API key, HMAC secret, integration IDs per method; test mode transactions succeed |
| **Shopify** | Honest OS → Shopify (products, prices if aligned, available stock); Shopify → Honest OS (orders, customers) | nothing in Honest OS scope (D-07) | Store plan, custom app with Admin API scopes (`read/write_products`, `read/write_inventory`, `read_orders`, `read_customers`), webhook secret |
| **Gmail** | Honest OS/Make → recipients (reports, statements) | nothing | Google Workspace domain; sending identity `reports@honesteg.co`; SPF/DKIM/DMARC |
| **Google Sheets / Drive** | Honest OS → Sheets (read-only exports); Drive archives | nothing | Service account or Make connection with access limited to one shared drive |
| **Meta Ads / GA4 / Looker Studio** | Read-only marketing data → reporting | nothing | Ad account + GA4 property access; Looker connects to a **reporting view**, never base tables |
| **ETA e-invoicing** | Honest OS → ETA (if D-02 = Honest OS issues) | e-invoice validity | Taxpayer ERP registration on ETA portal, client id/secret, signing (HSM/USB token) arrangement |
| **Claude API** | Honest OS ↔ Anthropic (Phase 7) | nothing | API key in Vercel env; data processing terms reviewed (PDPL) |

## 3. Dispatcher design (code, not Make.com)

```
Vercel Cron  ── every 2 min ──▶  POST /api/cron/outbox (Bearer CRON_SECRET)
  1. BEGIN; SELECT … FROM integration.outbox
       WHERE status IN ('pending','failed') AND next_attempt_at <= now()
       ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED;  → mark in_flight; COMMIT
  2. For each event: route by event_type → target(s) (config table integration.routes)
       POST signed payload (timeout 10 s)
  3. 2xx → delivered, delivered_at=now()
     4xx (except 408/429) → dead (payload/contract problem; alert)
     5xx/timeout/429 → failed, attempts+1, next_attempt_at = now() + backoff[attempts]
       backoff = [1m, 5m, 30m, 2h, 12h]; attempts ≥ 6 → dead
  4. Stuck in_flight > 10 min → back to failed (crash recovery)
Admin page "Integrations health": counts by status, oldest pending age, dead letters with Retry.
```

## 4. Make.com scenarios (module by module)

All scenarios start with the same **guard block**:
- **Module 1, Webhooks › Custom webhook.** Data structure "HonestEvent" (fields: `id`, `type`, `occurred_at`, `version`, `data`). Enable "Get request headers".
- **Module 2, Tools › Set variable** `sig_ok`. Formula: `sha256(X-Honest-Timestamp + "." + raw body; hex; OUTBOX_SIGNING_SECRET)` compared to the header. Store the secret in a Make **data store** or **custom variable**, never hard-coded in a module.
- **Filter** after Module 2: `sig_ok = true` AND `now - X-Honest-Timestamp < 300`. Failing requests go to the error route below.
- **Module 3, Data store › Search records** in store `processed_events` by key `id`. **Filter:** continue only if no record is found (idempotency).
- **Module 4, Data store › Add a record** `{id, type, processed_at}` (TTL housekeeping weekly).
- **Error handling:**
  - Every HTTP/messaging module gets an error handler route: **Break**, 3 attempts every 15 min, with "Store incomplete executions" ON.
  - If the signature fails, the route goes to **Webhook response** 401, then an email alert to the admin.
- **Webhook response** 200 is sent right after Module 4. The dispatcher must not wait on downstream modules.

### Scenario 1: Order approval notification
- **Trigger:** event `order.pending_approval`.
- **Module 5, HTTP › Make a request** `GET {APP}/api/integrations/approvers?request={data.approval_request_id}` with header `Authorization: Bearer MAKE_READ_TOKEN`. The read-only endpoint returns the approver's name, locale and WhatsApp number.
- **Module 6, Router:**
  - **Route A (WhatsApp)**, filter `approver.whatsapp_opt_in = true`. Module: WhatsApp Business Cloud › Send a template message.
    - Template `approval_request_v1`, category utility, language `ar`/`en` from `approver.locale`.
    - Body parameters: `{{data.order_no}}`, `{{data.customer.display_name}}`, `{{data.total}} EGP`, `{{data.reason}}`.
    - URL button: `{{data.approve_url}}`.
  - **Route B (Email)**, fallback (no opt-in). Module: Gmail › Send an email, from `notifications@honesteg.co`, same content.
- **Output:** the approver is notified. The in-app notification already exists (written by the DB command), so this scenario is a convenience channel only.

### Scenario 2: Missed follow-up reminder
- **Trigger:** event `task.overdue` (emitted by the daily `overdue-scan` cron at 09:00 Cairo).
- **Filter:** `data.kind in (follow_up, collection)`.
- **Module 5:** WhatsApp template `followup_reminder_v1` to the **rep** (utility): customer name, due date, deep link to the task.
- **Module 6 (Router):** if `data.days_overdue >= 3`, also send `followup_escalation_v1` to the rep's manager.
- **Output:** reminder sent. Repeats are prevented because the cron emits `task.overdue` once per task per day (outbox key `task.overdue:{task_id}:{date}`).

### Scenario 3: Low KPI alert
- **Trigger:** event `kpi.below_threshold`, emitted after the nightly KPI snapshot when achievement < pace (e.g. visits at day 15 < 40% of target).
- **Module 5:** Gmail › Send an email to the manager with a scorecard link.
- **Output:** coaching prompt. No automatic penalties.

### Scenario 4: Stock below reorder point / lot expiring
- **Trigger:** `stock.below_reorder` (from the movement trigger when available crosses `reorder_point` downward) or `lot.expiring` (daily scan: expiry ≤ 90/60/30 days).
- **Module 5, Router:**
  - Route A: Gmail to the purchasing/inventory manager.
  - Route B: Google Sheets › Add a row to the "Reorder queue" sheet. This is an export for planning; the sheet is not authoritative.
- **Output:** the purchasing team is alerted. Reservations and stock are already handled in the DB.

### Scenario 5: Invoice overdue → customer reminder
- **Trigger:** `invoice.overdue` (daily). Collection task creation already happened in the DB.
- **Filter:** `data.customer.whatsapp_opt_in = true` AND `data.days_overdue in (1, 7, 15, 30)`.
- **Module 5:** WhatsApp template `payment_reminder_v1` (utility) with invoice no, open amount and a Paymob payment link (when D-07/U-06 is resolved).
- **Output:** the reminder is logged back. The scenario calls `POST {APP}/api/integrations/activity` (signed) to record a CRM activity `whatsapp`. That is the only write path from Make, and it is an append-only activity, not business data.

### Scenario 6: Daily sales summary
- **Trigger:** `report.daily_sales` (cron 20:00 Cairo). The payload is a pre-computed summary from `api.report_daily_sales()`: totals by territory and brand, top reps, approvals pending, overdue AR.
- **Module 5:** Gmail › Send an email (HTML template) to the management distribution list.
- **Module 6:** Google Sheets › Add a row to the "Daily sales log" (history for Looker Studio, optional).

### Scenario 7: Weekly KPI and monthly performance reports
- Same pattern as Scenario 6 with `report.weekly_kpi` (Sunday 08:00 Cairo, to department managers) and `report.monthly_performance` (1st of month, to executives, with a PDF link to a stored report in Supabase Storage).

**Automation documentation template.** Every new scenario must fill this before it is built:

| Field | Value |
|-------|-------|
| Trigger | event type + emitting command/cron |
| Source → Destination | |
| Authentication | signing secret / connection owner |
| Input schema | event `data` fields used |
| Transformation | mapping table |
| Execution conditions | filters |
| Error handling / Retry | handler type, attempts |
| Idempotency | dedupe key |
| Logging | Make execution history + Honest outbox status |
| Monitoring | who gets alerted, how |

## 5. Direct integrations (in code)

### 5.1 Paymob (Phase 6)
- **Use cases:**
  - Payment links for overdue invoices.
  - Online checkout reconciliation (Shopify checkout already uses Paymob).
- **Outbound:** create a payment intention/link with the server-side secret key (endpoint and auth per Paymob's current Accept/Intention API docs, verified at the gate). `merchant_order_id = invoice_no` + attempt suffix.
- **Inbound:** transaction processed callback → verify HMAC per Paymob docs (field-ordered concatenation, SHA-512) → `inbound_webhooks` (unique `provider='paymob'`, `external_event_id = transaction id`) → `api.ingest_paymob_event`:
  - `success=true` and not `pending` → `finance.payments` (method `paymob_card`/`paymob_wallet`, `provider_txn_id`, status `confirmed`).
  - Auto-allocate to the invoice in `merchant_order_id` if the amount ≤ open amount; otherwise leave it unallocated for finance review.
  - Refund/void callbacks → `api.reverse_payment` path, with finance approval.
- **Reconciliation:** a daily job compares Paymob transactions (via Paymob API reporting, if available) against `finance.payments` by `provider_txn_id`. Mismatches go to the finance review queue.

### 5.2 Shopify (Phase 6, subject to D-07)
- **Products and stock (Honest OS → Shopify):**
  - Variant mapping in `integration.external_refs` (provider `shopify`, entity `variant`).
  - When `available` changes for a variant in the online-sales warehouse, an outbox `stock.changed` event triggers a GraphQL `inventorySetQuantities` to the mapped Shopify location (rate-limit aware, with batching).
- **Orders (Shopify → Honest OS):**
  - `orders/create` webhook → `api.import_shopify_order`. It finds or creates the customer (`source='shopify'`, duplicate check by phone/email), maps lines by variant ref, and creates an order with `channel='shopify'`.
  - Payment status comes from Paymob, the authoritative source. Stock is reserved in Honest OS.
- **Conflicts:**
  - Price or stock edits made in Shopify admin are overwritten on the next sync and logged as `integration.drift` warnings.
  - Unknown SKUs → order is held in `pending_mapping` and admin is alerted.

### 5.3 WhatsApp Cloud API (Phase 6)
- **Sending:** templates only for business-initiated messages; consent stored per contact (`whatsapp_opt_in_at`). Session messages are only for replies within the 24 h customer-service window.
- **Inbound:** messages → CRM activity on the matched contact (by phone). Unmatched numbers → "Unknown inbox" for marketing.
- **Cost control:** utility templates for transactional messages. Marketing templates need `marketing` consent and a separate approval.

### 5.4 ETA e-invoicing (Phase 4/6, only if D-02 = Honest OS issues e-invoices)
- `invoice.issued` → build the ETA document JSON (issuer, receiver tax id, item codes (EGS/GS1), tax types).
- Sign: the signing approach depends on the HSM/USB token arrangement. A token on a local machine would need a signing agent; this is the hardest part and is flagged R-01.
- Submit, then poll status. Store `eta_uuid` and `eta_status`. A rejection blocks sharing the invoice with the customer and alerts finance.
- If D-02 = "keep issuing from the accounting system", Honest OS instead exports invoice data to that system and imports the ETA UUID/status back.

## 6. Logging and monitoring

| What | Where |
|------|-------|
| Outbound delivery status, attempts, last error | `integration.outbox` |
| Inbound raw payloads, signature validity, processing outcome | `integration.inbound_webhooks` |
| Make execution history | Make.com (incomplete executions stored) |
| Alerts | Dead letters > 0, signature failures, oldest pending > 15 min, Shopify drift, Paymob reconciliation mismatches → admin in-app + email |
