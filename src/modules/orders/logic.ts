import { can, type UserContext } from "@/lib/authz/can";
import type { AppError } from "@/lib/errors";
import type { BuilderLine, OrderHistoryRow, OrderLineRow, OrderRow, OrderStatus, StockAvailableRow } from "./types";

/**
 * Pure order logic for the UI: the status machine, which actions to offer, and
 * display helpers. Offering an action is cosmetic — every api.* command
 * re-checks permission, record scope and status in Postgres.
 */

// ---------------------------------------------------------------------------
// Status machine. Mirrors sales.order_transitions (supabase/migrations/
// 20261028001500_reference_data.sql); tests/unit/orders-logic.test.ts parses
// that migration and suite 21 compares the table, so drift fails a test.
// ---------------------------------------------------------------------------
export interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  /** Permission recorded in the DB for the transition (workflow hooks satisfy wf.decide.*). */
  permission: string;
}

export const ORDER_TRANSITIONS: readonly Transition[] = [
  { from: "draft", to: "submitted", permission: "sales.order.submit" },
  { from: "draft", to: "pending_approval", permission: "sales.order.submit" },
  { from: "draft", to: "cancelled", permission: "sales.order.create" },
  { from: "pending_approval", to: "approved", permission: "wf.decide.order_discount" },
  { from: "pending_approval", to: "rejected", permission: "wf.decide.order_discount" },
  { from: "submitted", to: "approved", permission: "sales.order.approve" },
  { from: "submitted", to: "rejected", permission: "sales.order.approve" },
  { from: "submitted", to: "cancelled", permission: "sales.order.cancel" },
  { from: "approved", to: "reserved", permission: "sales.order.fulfil" },
  { from: "approved", to: "cancelled", permission: "wf.decide.order_cancel" },
  { from: "reserved", to: "partially_fulfilled", permission: "sales.order.fulfil" },
  { from: "reserved", to: "fulfilled", permission: "sales.order.fulfil" },
  { from: "reserved", to: "cancelled", permission: "wf.decide.order_cancel" },
  { from: "partially_fulfilled", to: "fulfilled", permission: "sales.order.fulfil" },
  { from: "fulfilled", to: "invoiced", permission: "finance.invoice.issue" },
  { from: "partially_fulfilled", to: "invoiced", permission: "finance.invoice.issue" },
  { from: "invoiced", to: "closed", permission: "finance.invoice.issue" },
  { from: "invoiced", to: "returned", permission: "sales.return.create" },
  { from: "closed", to: "returned", permission: "sales.return.create" },
];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** Statuses an order may still move out of. */
export function isTerminal(status: OrderStatus): boolean {
  return !ORDER_TRANSITIONS.some((t) => t.from === status);
}

/**
 * The commands the UI offers, the statuses each accepts (as the command checks
 * them) and the transition it performs. Edit keeps the order in draft.
 */
export const ACTION_STATUSES = {
  edit: ["draft"],
  submit: ["draft"],
  approve: ["submitted"],
  reject: ["submitted"],
  reserve: ["approved"],
  fulfil: ["reserved", "partially_fulfilled"],
  // api.cancel_order: draft/submitted directly, approved/reserved via the 'sales.order.cancel' workflow.
  cancel: ["draft", "submitted", "approved", "reserved"],
} as const satisfies Record<string, readonly OrderStatus[]>;
export type OrderAction = keyof typeof ACTION_STATUSES;

export const ACTION_TARGETS: Record<Exclude<OrderAction, "edit">, readonly OrderStatus[]> = {
  submit: ["submitted", "pending_approval"],
  approve: ["approved"],
  reject: ["rejected"],
  reserve: ["reserved"],
  fulfil: ["partially_fulfilled", "fulfilled"],
  cancel: ["cancelled"],
};

/** Cancelling these needs an approval (the order changes only when it is granted). */
const CANCEL_BY_REQUEST: readonly OrderStatus[] = ["approved", "reserved"];

export interface AvailableActions {
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  reserve: boolean;
  fulfil: boolean;
  /** "direct" cancels now; "request" asks for approval; null = not offered. */
  cancel: "direct" | "request" | null;
  /** A cancellation request is already waiting for a decision. */
  cancelPending: boolean;
}

type OrderForActions = Pick<OrderRow, "status" | "employee_id" | "pending_approval_request_id">;

/** The signed-in user is the order's representative. */
export function isOwnOrder(ctx: UserContext, order: Pick<OrderRow, "employee_id">): boolean {
  return ctx.employee !== null && ctx.employee.id === order.employee_id;
}

/** After approval the only pending request on an order is a cancellation (api.v_orders.pending_approval_request_id). */
export function hasPendingCancel(order: Pick<OrderRow, "status" | "pending_approval_request_id">): boolean {
  return CANCEL_BY_REQUEST.includes(order.status) && order.pending_approval_request_id !== null;
}

const allows = (action: OrderAction, status: OrderStatus) => (ACTION_STATUSES[action] as readonly OrderStatus[]).includes(status);

/** Which actions to show for an order. Mirrors the checks in api.* (…_orders_inventory_workflow.sql §3). */
export function availableActions(
  ctx: UserContext,
  order: OrderForActions,
  lines: readonly Pick<OrderLineRow, "reserved_qty">[] = [],
): AvailableActions {
  const own = isOwnOrder(ctx, order);
  const cancelPending = hasPendingCancel(order);
  const { status } = order;

  // api.approve_order / api.reject_order refuse your own order (SELF_APPROVAL).
  const mayDecide = can(ctx, "sales.order.approve") && !own;
  const mayFulfil = can(ctx, "sales.order.fulfil") && !cancelPending;

  let cancel: AvailableActions["cancel"] = null;
  if (allows("cancel", status) && !cancelPending) {
    // Draft, approved, reserved: the rep's own order (with sales.order.create) or sales.order.cancel.
    // Submitted: sales.order.cancel only.
    const ownCancel = own && can(ctx, "sales.order.create");
    const mayCancel = status === "submitted" ? can(ctx, "sales.order.cancel") : ownCancel || can(ctx, "sales.order.cancel");
    if (mayCancel) cancel = CANCEL_BY_REQUEST.includes(status) ? "request" : "direct";
  }

  return {
    edit: allows("edit", status) && can(ctx, "sales.order.create"),
    submit: allows("submit", status) && can(ctx, "sales.order.submit"),
    approve: allows("approve", status) && mayDecide,
    reject: allows("reject", status) && mayDecide,
    reserve: allows("reserve", status) && mayFulfil,
    // api.post_fulfillment consumes active reservations; without any it raises NOTHING_TO_FULFIL.
    fulfil: allows("fulfil", status) && mayFulfil && lines.some((l) => l.reserved_qty > 0),
    cancel,
    cancelPending,
  };
}

// ---------------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------------
export const STATUS_FILTERS = {
  all: [],
  draft: ["draft"],
  awaiting: ["submitted", "pending_approval"],
  approved: ["approved", "reserved", "partially_fulfilled"],
  fulfilled: ["fulfilled", "invoiced", "closed"],
  closed: ["rejected", "cancelled", "returned"],
} as const satisfies Record<string, readonly OrderStatus[]>;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export function parseStatusFilter(value: string | string[] | undefined): StatusFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && Object.hasOwn(STATUS_FILTERS, v) ? (v as StatusFilter) : "all";
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function statusTone(status: OrderStatus): BadgeTone {
  switch (status) {
    case "draft":
      return "neutral";
    case "submitted":
    case "pending_approval":
      return "warning";
    case "approved":
    case "reserved":
    case "partially_fulfilled":
      return "info";
    case "fulfilled":
    case "invoiced":
    case "closed":
      return "success";
    default:
      return "danger";
  }
}

// ---------------------------------------------------------------------------
// Submit outcome
// ---------------------------------------------------------------------------
export type ApprovalReason = "discount" | "credit";

/**
 * Why an order waits for approval. api.submit_order writes the reasons
 * ('discount above limit', 'credit limit', joined by '; ') into the history row
 * of the draft → pending_approval transition.
 */
export function approvalReasons(history: readonly Pick<OrderHistoryRow, "id" | "to_status" | "reason">[]): ApprovalReason[] {
  const row = [...history].filter((h) => h.to_status === "pending_approval").sort((a, b) => b.id - a.id)[0];
  if (!row?.reason) return [];
  const out = new Set<ApprovalReason>();
  for (const part of row.reason.split(";").map((p) => p.trim().toLowerCase())) {
    if (part.startsWith("discount")) out.add("discount");
    else if (part.startsWith("credit")) out.add("credit");
  }
  return [...out];
}

/**
 * A history row's reason for display. The commands write a few fixed English
 * phrases (translated here); anything else is a person's own words or a
 * document number, shown as written.
 */
export type HistoryReason =
  | { kind: "none" }
  | { kind: "draftCreated" }
  | { kind: "accepted" }
  | { kind: "approvalDecision" }
  | { kind: "approvalReasons"; reasons: ApprovalReason[] }
  | { kind: "text"; text: string };

export function describeHistoryReason(row: Pick<OrderHistoryRow, "to_status" | "reason">): HistoryReason {
  const reason = row.reason?.trim();
  if (!reason) return { kind: "none" };
  if (row.to_status === "draft" && reason === "draft created") return { kind: "draftCreated" };
  if (row.to_status === "approved" && reason === "accepted") return { kind: "accepted" };
  if (/^approval request [0-9a-f-]{36}$/i.test(reason)) return { kind: "approvalDecision" };
  if (row.to_status === "pending_approval") {
    const reasons = approvalReasons([{ id: 0, to_status: "pending_approval", reason }]);
    if (reasons.length > 0) return { kind: "approvalReasons", reasons };
  }
  return { kind: "text", text: reason };
}

// ---------------------------------------------------------------------------
// Warehouse picker for reservations
// ---------------------------------------------------------------------------
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  /** Every open line can be reserved in full from this warehouse (indicative: stock may move). */
  coversAll: boolean;
  /** Open lines this warehouse cannot cover in full. */
  shortLines: number;
}

/**
 * Warehouses with sellable stock (api.v_stock_available) for the order's
 * variants, best coverage first. The reservation itself is all-or-nothing in
 * api.reserve_order (INSUFFICIENT_STOCK), so this only guides the choice.
 */
export function warehouseOptions(
  stock: readonly StockAvailableRow[],
  lines: readonly Pick<OrderLineRow, "variant_id" | "quantity" | "fulfilled_qty" | "reserved_qty">[],
): WarehouseOption[] {
  const need = new Map<string, number>();
  for (const l of lines) {
    const open = l.quantity - l.fulfilled_qty - l.reserved_qty;
    if (open > 0) need.set(l.variant_id, (need.get(l.variant_id) ?? 0) + open);
  }
  const byWarehouse = new Map<string, { code: string; name: string; available: Map<string, number> }>();
  for (const s of stock) {
    if (!need.has(s.variant_id)) continue;
    const w = byWarehouse.get(s.warehouse_id) ?? { code: s.warehouse_code, name: s.warehouse_name, available: new Map() };
    w.available.set(s.variant_id, (w.available.get(s.variant_id) ?? 0) + Number(s.available));
    byWarehouse.set(s.warehouse_id, w);
  }
  return [...byWarehouse.entries()]
    .map(([id, w]) => {
      const shortLines = [...need.entries()].filter(([variant, qty]) => (w.available.get(variant) ?? 0) < qty).length;
      return { id, code: w.code, name: w.name, coversAll: shortLines === 0, shortLines };
    })
    .sort((a, b) => a.shortLines - b.shortLines || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Codes with a message under orders.errors.* (business codes raised by the order commands first). */
export const ORDER_ERROR_CODES = [
  "CUSTOMER_BLOCKED",
  "WAREHOUSE_NOT_SELLABLE",
  "INSUFFICIENT_STOCK",
  "NO_PRICE",
  "EMPTY_ORDER",
  "VARIANT_NOT_SELLABLE",
  "CANCEL_PENDING",
  "SELF_APPROVAL",
  "NOTHING_TO_FULFIL",
  "MULTI_WAREHOUSE",
  "IDEMPOTENCY_CONFLICT",
  "NO_EMPLOYEE_PROFILE",
  "WORKFLOW_MISSING",
  "CONFLICT",
  "INVALID_STATE",
  "REASON_REQUIRED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "VALIDATION",
  "DUPLICATE",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[number];

const isOrderErrorCode = (code: string): code is OrderErrorCode => (ORDER_ERROR_CODES as readonly string[]).includes(code);

/** Which orders.errors.* message to show for a failed command or read. */
export function orderErrorCode(error: Pick<AppError, "code" | "messageKey" | "detail">): OrderErrorCode {
  // api.save_order_draft raises 'NOT_FOUND: variant … is not sellable' for inactive variants.
  if (error.code === "NOT_FOUND" && /not sellable/i.test(error.detail)) return "VARIANT_NOT_SELLABLE";
  if (isOrderErrorCode(error.code)) return error.code;
  if (isOrderErrorCode(error.messageKey)) return error.messageKey;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
/** numeric from PostgREST (number or string) → number; NaN-safe. */
export function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

/**
 * Catalogue search text → a safe PostgREST `ilike` pattern body. Keeps letters
 * (incl. Arabic), digits, spaces and . - / ; drops everything else (commas and
 * parentheses would break an `or=(…)` filter, % and * are wildcards).
 */
export function sanitizeSearch(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s.\-/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Up to this many lines per order (api.save_order_draft refuses more than 200). */
export const MAX_LINES = 200;
export const MAX_QUANTITY = 100_000;

/** Saved draft lines → builder lines (one per variant; quantities of repeated variants are summed). */
export function linesToBuilder(lines: readonly Pick<OrderLineRow, "variant_id" | "quantity" | "sku" | "variant_name">[]): BuilderLine[] {
  return lines.reduce<BuilderLine[]>(
    (acc, l) => addLine(acc, { variant_id: l.variant_id, quantity: l.quantity, sku: l.sku ?? "", name: l.variant_name ?? l.sku ?? "" }),
    [],
  );
}

/** Adds a variant to builder lines, or increases its quantity if already present. */
export function addLine<L extends { variant_id: string; quantity: number }>(lines: readonly L[], line: L): L[] {
  const i = lines.findIndex((l) => l.variant_id === line.variant_id);
  if (i === -1) return lines.length >= MAX_LINES ? [...lines] : [...lines, line];
  return lines.map((l, j) => (j === i ? { ...l, quantity: Math.min(MAX_QUANTITY, l.quantity + line.quantity) } : l));
}
