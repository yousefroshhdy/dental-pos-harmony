import { can, type UserContext } from "@/lib/authz/can";
import type { AppError } from "@/lib/errors";
import type { Numeric, ReasonCode, ReturnableLineRow, ReturnRow, ReturnStatus } from "./types";
import { REASON_CODES, RETURN_STATUSES } from "./types";

/**
 * Pure logic for the returns screens. Every rule here is a courtesy for the
 * user: api.request_return / receive_return / credit_return re-check
 * permission, scope, state and quantities in Postgres and compute every amount.
 */

// ---------------------------------------------------------------------------
// Permissions (docs/AUTHORIZATION.md; seeded in 20261103000200_returns.sql)
// ---------------------------------------------------------------------------
export const RETURN_PERMISSIONS = {
  request: "sales.return.request",
  receive: "sales.return.receive",
  credit: "sales.return.credit",
} as const;

/** Who may open the returns list: anyone who handles returns or reads orders (RLS scopes the rows). */
export function canSeeReturns(ctx: UserContext): boolean {
  return [...Object.values(RETURN_PERMISSIONS), "sales.order.read"].some((p) => can(ctx, p));
}

export function canReceive(ctx: UserContext, row: Pick<ReturnRow, "status">): boolean {
  return row.status === "approved" && can(ctx, RETURN_PERMISSIONS.receive);
}

export function canCredit(ctx: UserContext, row: Pick<ReturnRow, "status">): boolean {
  return row.status === "received" && can(ctx, RETURN_PERMISSIONS.credit);
}

/** Decides 'sales.return' approvals (seeded workflow); may also cancel an approved return. */
export const RETURN_DECIDE_PERMISSION = "wf.decide.return";

/**
 * Mirrors api.cancel_return: a pending return is withdrawn by its requester; an approved
 * return that was never received is cancelled by a return approver or the warehouse.
 */
export function canCancel(ctx: UserContext, row: Pick<ReturnRow, "status" | "is_mine">): boolean {
  if (row.status === "requested" || row.status === "pending_approval") return row.is_mine && can(ctx, RETURN_PERMISSIONS.request);
  if (row.status === "approved") return can(ctx, RETURN_DECIDE_PERMISSION) || can(ctx, RETURN_PERMISSIONS.receive);
  return false;
}

/** Order statuses api.request_return accepts (delivered goods). */
export const RETURNABLE_ORDER_STATUSES = ["partially_fulfilled", "fulfilled", "invoiced", "closed"] as const;

export function orderAcceptsReturns(status: string | null | undefined): boolean {
  return (RETURNABLE_ORDER_STATUSES as readonly string[]).includes(status ?? "");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export const RETURN_ERROR_CODES = [
  "QTY_EXCEEDS_RETURNABLE",
  "WAREHOUSE_NOT_QUARANTINE",
  "CREDIT_QTY_EXCEEDED",
  "EXCEEDS_INVOICE_OPEN_AMOUNT",
  "IDEMPOTENCY_CONFLICT",
  "SELF_APPROVAL",
  "REASON_REQUIRED",
  "INVALID_STATE",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "VALIDATION",
  "DUPLICATE",
  "CONFLICT",
  "UNAVAILABLE",
  "MFA_REQUIRED",
  "UNKNOWN",
] as const;
export type ReturnErrorCode = (typeof RETURN_ERROR_CODES)[number];

const isReturnErrorCode = (code: string): code is ReturnErrorCode => (RETURN_ERROR_CODES as readonly string[]).includes(code);

/** Which returns.errors.* message to show for a failed command or read. */
export function returnErrorCode(error: Pick<AppError, "code" | "messageKey">): ReturnErrorCode {
  if (isReturnErrorCode(error.code)) return error.code;
  if (isReturnErrorCode(error.messageKey)) return error.messageKey;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function statusTone(status: ReturnStatus): BadgeTone {
  switch (status) {
    case "requested":
    case "pending_approval":
      return "warning";
    case "approved":
      return "info";
    case "received":
      return "info";
    case "credited":
      return "success";
    case "rejected":
      return "danger";
    case "cancelled":
      return "neutral";
    default:
      return "neutral";
  }
}

export function isReturnStatus(value: unknown): value is ReturnStatus {
  return typeof value === "string" && (RETURN_STATUSES as readonly string[]).includes(value);
}

/** List filters → statuses (empty = all). "open" = still waiting for someone. */
export const STATUS_FILTERS = {
  all: [],
  open: ["requested", "pending_approval", "approved", "received"],
  pending_approval: ["requested", "pending_approval"],
  approved: ["approved"],
  received: ["received"],
  credited: ["credited"],
  rejected: ["rejected"],
  cancelled: ["cancelled"],
} as const satisfies Record<string, readonly ReturnStatus[]>;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export function parseStatusFilter(raw: string | string[] | undefined): StatusFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && Object.hasOwn(STATUS_FILTERS, value) ? (value as StatusFilter) : "all";
}

/** The next step of a return, as a key under `returns.next.*`. */
export function nextStepKey(status: ReturnStatus): "approval" | "receive" | "credit" | "done" | "closed" | "cancelled" {
  switch (status) {
    case "cancelled":
      return "cancelled";
    case "requested":
    case "pending_approval":
      return "approval";
    case "approved":
      return "receive";
    case "received":
      return "credit";
    case "credited":
      return "done";
    default:
      return "closed";
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function toNumber(value: Numeric | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

/** Arabic-Indic and Extended Arabic-Indic digits → ASCII. */
export function normalizeDigits(raw: string): string {
  return raw.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** A typed quantity → whole number ≥ 0, or null if it is not one. Empty means 0. */
export function parseQuantity(raw: string | null | undefined): number | null {
  const text = normalizeDigits(raw ?? "").trim();
  if (text === "") return 0;
  if (!/^\d{1,6}$/.test(text)) return null;
  return Number(text);
}

export const isReasonCode = (v: unknown): v is ReasonCode => typeof v === "string" && (REASON_CODES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// The request form
// ---------------------------------------------------------------------------
/** Key of one returnable row (order line × delivered lot) in the form. */
export const lineKey = (row: Pick<ReturnableLineRow, "order_item_id" | "lot_id">) => `${row.order_item_id}_${row.lot_id}`;

export interface RequestLine {
  order_item_id: string;
  lot_id: string;
  quantity: number;
  reason_code: ReasonCode;
}

export type LineCheck =
  | { ok: true; lines: RequestLine[] }
  | { ok: false; reason: "noLines" | "invalidQuantity" | "tooMany" | "missingReason" | "notesRequired" };

/**
 * Turn the typed quantities and reasons into the lines api.request_return takes.
 * Rows with no (or 0) quantity are skipped; at least one line is needed.
 */
export function checkRequestLines(
  quantities: Record<string, string>,
  reasons: Record<string, string>,
  rows: Pick<ReturnableLineRow, "order_item_id" | "lot_id" | "returnable_qty">[],
  notes: string,
): LineCheck {
  const lines: RequestLine[] = [];
  for (const row of rows) {
    const key = lineKey(row);
    const qty = parseQuantity(quantities[key]);
    if (qty === null) return { ok: false, reason: "invalidQuantity" };
    if (qty === 0) continue;
    if (qty > row.returnable_qty) return { ok: false, reason: "tooMany" };
    const reason = reasons[key];
    if (!isReasonCode(reason)) return { ok: false, reason: "missingReason" };
    lines.push({ order_item_id: row.order_item_id, lot_id: row.lot_id, quantity: qty, reason_code: reason });
  }
  if (lines.length === 0) return { ok: false, reason: "noLines" };
  if (lines.some((l) => l.reason_code === "other") && notes.trim() === "") return { ok: false, reason: "notesRequired" };
  return { ok: true, lines };
}

/** Rows that still have something to return, in order-line order. */
export function returnableRows<T extends Pick<ReturnableLineRow, "returnable_qty" | "line_no" | "lot_no">>(rows: T[]): T[] {
  return rows
    .filter((r) => r.returnable_qty > 0)
    .sort((a, b) => a.line_no - b.line_no || (a.lot_no ?? "").localeCompare(b.lot_no ?? ""));
}
