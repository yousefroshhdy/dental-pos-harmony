import { APPROVAL_ERROR_KEYS, type ApprovalErrorKey, type ApprovalRequestRow, type NotificationRow, type RequestStatus, type Verdict } from "./types";

/**
 * Pure presentation logic for the approvals inbox and notifications. UI gating
 * here is cosmetic: api.decide_approval re-checks every rule in Postgres.
 */

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/** wf.workflow_definitions.code → key under `approvals.workflows.*` (codes seeded in …_reference_data.sql). */
export const WORKFLOW_LABEL_KEYS: Record<string, string> = {
  "sales.order.discount": "orderDiscount",
  "sales.order.cancel": "orderCancel",
  "sales.return": "salesReturn",
  "inventory.adjustment": "inventoryAdjustment",
  "crm.customer.reassign": "customerReassign",
  "field.visit.exception": "visitException",
  "finance.credit_note": "creditNote",
  "finance.credit_limit": "creditLimit",
  "perf.commission_period": "commissionPeriod",
  "perf.commission_adjustment": "commissionAdjustment",
  "data.export": "dataExport",
};
const WORKFLOW_ORDER = Object.keys(WORKFLOW_LABEL_KEYS);

/** Translation key for a workflow, or null for a code the UI does not know (show the DB name instead). */
export function workflowLabelKey(code: string | null | undefined): string | null {
  return (code && WORKFLOW_LABEL_KEYS[code]) || null;
}

export interface WorkflowGroup<T> {
  code: string;
  rows: T[];
}

/** Rows grouped by workflow (known workflows in a fixed order, unknown ones after, by code); row order kept. */
export function groupByWorkflow<T extends { workflow_code: string }>(rows: T[]): WorkflowGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.workflow_code) ?? [];
    list.push(row);
    groups.set(row.workflow_code, list);
  }
  const rank = (code: string) => {
    const i = WORKFLOW_ORDER.indexOf(code);
    return i === -1 ? WORKFLOW_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([code, list]) => ({ code, rows: list }));
}

// ---------------------------------------------------------------------------
// Status, verdict, errors
// ---------------------------------------------------------------------------

export function statusTone(status: RequestStatus): BadgeTone {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Key under `approvals.verdict.*` explaining why the caller cannot decide, or
 * null when they can (or the request is closed and the status says it all).
 */
export function verdictKey(verdict: Verdict | null | undefined): Exclude<Verdict, "ok"> | null {
  if (!verdict || verdict === "ok") return null;
  return verdict;
}

/** Map a failed api.decide_approval call to a key under `approvals.errors.*`. */
export function errorKeyFor(error: { code: string; messageKey: string }): ApprovalErrorKey {
  const known = APPROVAL_ERROR_KEYS as readonly string[];
  if (known.includes(error.code)) return error.code as ApprovalErrorKey;
  if (known.includes(error.messageKey)) return error.messageKey as ApprovalErrorKey;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Time waiting
// ---------------------------------------------------------------------------

export type WaitUnit = "minute" | "hour" | "day";

/** How long a request has waited at its current stage, in the largest whole unit (minimum 0 minutes). */
export function waitingFor(fromIso: string, now: Date): { unit: WaitUnit; count: number } {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 60) return { unit: "minute", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hour", count: hours };
  return { unit: "day", count: Math.floor(hours / 24) };
}

/** A pending stage older than this is highlighted in the inbox. */
export const OVERDUE_HOURS = 48;

export function isOverdue(fromIso: string, now: Date, hours = OVERDUE_HOURS): boolean {
  return now.getTime() - new Date(fromIso).getTime() >= hours * 3_600_000;
}

// ---------------------------------------------------------------------------
// Subject record
// ---------------------------------------------------------------------------

export interface SubjectLink {
  href: string;
  /** Key under `approvals.subject.*`. */
  labelKey: "openOrder" | "openCustomer" | "openVisit" | "openStock";
}

/**
 * Route of the record a request is about. These routes belong to other modules;
 * only well-formed ids are put into a URL.
 */
export function subjectLink(row: Pick<ApprovalRequestRow, "entity_type" | "entity_id" | "payload">): SubjectLink | null {
  const payload = row.payload ?? {};
  switch (row.entity_type) {
    case "sales.order":
      return isUuid(row.entity_id) ? { href: `/orders/${row.entity_id}`, labelKey: "openOrder" } : null;
    case "crm.customer":
      return isUuid(row.entity_id) ? { href: `/customers/${row.entity_id}`, labelKey: "openCustomer" } : null;
    case "field.visit":
      return isUuid(row.entity_id) ? { href: `/visits/${row.entity_id}`, labelKey: "openVisit" } : null;
    case "inventory.adjustment": {
      // The entity id is a synthetic key (md5 of the idempotency key); link to the stock it changes:
      // the SKU's lot drill-down /inventory/stock/[variantId]?warehouse=…, else the stock overview /inventory.
      const warehouse = payload.warehouse_id;
      const variant = payload.variant_id;
      const query = isUuid(warehouse) ? `?warehouse=${warehouse}` : "";
      return { href: isUuid(variant) ? `/inventory/stock/${variant}${query}` : `/inventory${query}`, labelKey: "openStock" };
    }
    default:
      if (isUuid(payload.order_id)) return { href: `/orders/${payload.order_id}`, labelKey: "openOrder" };
      if (isUuid(payload.customer_id)) return { href: `/customers/${payload.customer_id}`, labelKey: "openCustomer" };
      return null;
  }
}

// ---------------------------------------------------------------------------
// What is being approved (from the frozen payload)
// ---------------------------------------------------------------------------

export type FactKind = "money" | "percent" | "units" | "signedUnits" | "meters" | "text" | "visitStatus" | "flag";

export interface Fact {
  /** Key under `approvals.facts.*`. */
  key: string;
  kind: FactKind;
  value: string | number;
}

/** numeric/jsonb number → number | null. PostgREST may send numeric as a string. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const joined = (...parts: (string | null | undefined)[]) => parts.filter((p) => p && p.trim() !== "").join(" — ") || null;

function push(facts: Fact[], key: string, kind: FactKind, value: string | number | null) {
  if (value !== null) facts.push({ key, kind, value });
}

/** The amounts, limits and context a decider needs, per workflow. Missing values are left out. */
export function requestFacts(row: ApprovalRequestRow, locale: string): Fact[] {
  const p = row.payload ?? {};
  const facts: Fact[] = [];
  const customer = row.customer_name ? (row.customer_no ? `${row.customer_name} (${row.customer_no})` : row.customer_name) : null;

  switch (row.workflow_code) {
    case "sales.order.discount":
      push(facts, "orderNo", "text", text(p.order_no));
      push(facts, "customer", "text", customer);
      push(facts, "orderTotal", "money", toNumber(p.total));
      if (p.discount_exceeded === true) facts.push({ key: "discountExceeded", kind: "flag", value: 1 });
      if (p.credit_exceeded === true) facts.push({ key: "creditExceeded", kind: "flag", value: 1 });
      push(facts, "requestedDiscount", "percent", toNumber(p.max_manual_discount_pct));
      push(facts, "requesterDiscountLimit", "percent", toNumber(p.limit_pct));
      if (p.credit_exceeded === true) {
        push(facts, "creditLimit", "money", toNumber(p.credit_limit));
        push(facts, "balance", "money", toNumber(p.balance));
        push(facts, "exposure", "money", toNumber(p.exposure));
        push(facts, "creditExcess", "money", toNumber(p.credit_excess));
      }
      break;
    case "sales.order.cancel":
      push(facts, "orderNo", "text", text(p.order_no));
      push(facts, "customer", "text", customer);
      push(facts, "orderTotal", "money", toNumber(p.total));
      push(facts, "fromStatus", "text", text(p.from_status));
      push(facts, "reason", "text", text(p.reason));
      break;
    case "inventory.adjustment":
      push(facts, "warehouse", "text", joined(row.warehouse_code, row.warehouse_name));
      push(facts, "variant", "text", joined(row.variant_sku, row.variant_name));
      push(facts, "quantity", "signedUnits", toNumber(p.quantity));
      push(facts, "requesterUnitLimit", "units", toNumber(p.requester_limit));
      push(facts, "adjustedToday", "units", toNumber(p.already_adjusted_today));
      push(facts, "reason", "text", text(p.reason));
      break;
    case "crm.customer.reassign":
      push(facts, "customer", "text", customer);
      push(facts, "fromEmployee", "text", localizedName(locale, row.from_employee_name_en, row.from_employee_name_ar) || null);
      push(facts, "toEmployee", "text", localizedName(locale, row.to_employee_name_en, row.to_employee_name_ar) || null);
      push(facts, "reason", "text", text(p.reason));
      break;
    case "field.visit.exception":
      push(facts, "customer", "text", customer);
      push(facts, "visitStatus", "visitStatus", text(p.original_status));
      push(facts, "distance", "meters", toNumber(p.distance_m));
      push(facts, "accuracy", "meters", toNumber(p.accuracy_m));
      push(facts, "reason", "text", text(p.reason));
      break;
    default:
      push(facts, "customer", "text", customer);
      push(facts, "amount", "money", toNumber(p.total ?? p.amount));
      push(facts, "reason", "text", text(p.reason));
  }
  return facts;
}

/** Short subject line for an inbox card (order no., customer, SKU @ warehouse), or null if nothing is readable. */
export function requestTitle(row: ApprovalRequestRow): string | null {
  const p = row.payload ?? {};
  const orderNo = text(p.order_no);
  switch (row.workflow_code) {
    case "sales.order.discount":
    case "sales.order.cancel":
      return joined(orderNo, row.customer_name);
    case "inventory.adjustment":
      return row.variant_sku && row.warehouse_code ? `${row.variant_sku} @ ${row.warehouse_code}` : (row.variant_sku ?? row.warehouse_code);
    default:
      return joined(orderNo, row.customer_name);
  }
}

/** The single most useful number for an inbox card, if any. */
export function headlineFact(facts: Fact[]): Fact | null {
  const order = ["orderTotal", "quantity", "amount", "requestedDiscount", "distance"];
  for (const key of order) {
    const fact = facts.find((f) => f.key === key);
    if (fact) return fact;
  }
  return null;
}

/** Visit verification statuses with a translation under `approvals.visitStatus.*`. */
export const VISIT_STATUSES = ["out_of_range", "no_customer_location", "no_device_location", "low_accuracy"] as const;

export function visitStatusKey(value: string | number): (typeof VISIT_STATUSES)[number] | null {
  return (VISIT_STATUSES as readonly string[]).includes(String(value)) ? (value as (typeof VISIT_STATUSES)[number]) : null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * A notification link as an in-app path (without the locale prefix, for the
 * locale-aware Link), or null if it is not a safe same-origin path.
 */
export function safeInternalHref(link: string | null | undefined): string | null {
  if (typeof link !== "string" || link.length === 0 || link.length > 512) return null;
  if (!link.startsWith("/") || link.startsWith("//") || link.includes("\\") || /\s/.test(link)) return null;
  if ([...link].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return null;
  const stripped = link.replace(/^\/(ar|en)(?=\/|$|\?|#)/, "");
  return stripped === "" ? "/" : stripped;
}

export type NotificationKind =
  | "approvalRequested"
  | "approvalApproved"
  | "approvalRejected"
  | "orderApproved"
  | "orderRejected"
  | "orderCancelled"
  | "visitExceptionApproved"
  | "visitExceptionRejected"
  | "customerAssigned"
  | "customerUnassigned"
  | "taskAssigned";

/** Translated template for known notification types; null → show the stored title. */
export function notificationKind(row: Pick<NotificationRow, "type" | "data">): NotificationKind | null {
  const data = row.data ?? {};
  switch (row.type) {
    case "approval.requested":
      return "approvalRequested";
    case "approval.decided":
      return data.decision === "approved" ? "approvalApproved" : data.decision === "rejected" ? "approvalRejected" : null;
    case "order.approved":
      return "orderApproved";
    case "order.rejected":
      return "orderRejected";
    case "order.cancelled":
      return "orderCancelled";
    case "visit.exception_decided":
      return data.approved === true ? "visitExceptionApproved" : data.approved === false ? "visitExceptionRejected" : null;
    case "customer.assigned":
      return "customerAssigned";
    case "customer.unassigned":
      return "customerUnassigned";
    case "task.assigned":
      return "taskAssigned";
    default:
      return null;
  }
}

export function unreadIds(rows: Pick<NotificationRow, "id" | "read_at">[]): string[] {
  return rows.filter((r) => r.read_at === null).map((r) => r.id);
}

/** Badge text for an unread count: nothing at 0, capped at 99+. */
export function badgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
