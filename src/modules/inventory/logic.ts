import { z } from "zod";
import { can, canAny, limitOf, type UserContext } from "@/lib/authz/can";
import { TRANSLATED_CODES } from "@/lib/errors";
import {
  MOVEMENT_TYPES,
  RECEIPT_STATUSES,
  TRANSFER_STATUSES,
  type AdjustmentOutcome,
  type MovementType,
  type ReceiptStatus,
  type ReorderAlertRow,
  type StockDetailRow,
  type StockRow,
  type TransferRow,
  type TransferStatus,
  type VariantRow,
  type WarehouseKind,
} from "./types";

/**
 * Pure presentation logic for the inventory workspace. Gating here is
 * cosmetic: Postgres re-checks every permission and warehouse scope, and the
 * ledger rules (no negative stock, expired lots only into quarantine, approval
 * above the daily adjustment limit) live in the api.* commands.
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

/** Audit rule (a): quarantine and transit stock is never sellable. */
export function isSellableKind(kind: WarehouseKind | null | undefined): boolean {
  return kind !== "quarantine" && kind !== "transit" && kind !== null && kind !== undefined;
}

export function warehouseKindTone(kind: WarehouseKind | null | undefined): BadgeTone {
  if (kind === "quarantine") return "danger";
  if (kind === "transit") return "warning";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Expiry (dates are Cairo calendar days)
// ---------------------------------------------------------------------------

/** "Near expiry" window, matching api.v_inventory_stock.near_expiry_qty. */
export const EXPIRY_NEAR_DAYS = 90;
/** Inside this many days the badge turns red. */
export const EXPIRY_CRITICAL_DAYS = 30;

export type ExpiryStatus = "none" | "ok" | "near" | "critical" | "expired";

export function expiryStatus(daysToExpiry: number | null | undefined): ExpiryStatus {
  if (daysToExpiry === null || daysToExpiry === undefined) return "none";
  if (daysToExpiry < 0) return "expired";
  if (daysToExpiry < EXPIRY_CRITICAL_DAYS) return "critical";
  if (daysToExpiry < EXPIRY_NEAR_DAYS) return "near";
  return "ok";
}

export function expiryTone(status: ExpiryStatus): BadgeTone {
  return status === "expired" || status === "critical" ? "danger" : status === "near" ? "warning" : "neutral";
}

const cairoDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date in Cairo as YYYY-MM-DD. */
export function cairoToday(now: Date = new Date()): string {
  return cairoDate.format(now);
}

/** Whole days from `today` to `date` (both YYYY-MM-DD); negative when past. */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

function cairoOffsetMinutes(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? "");
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The UTC instant at which Cairo day `day` (YYYY-MM-DD) starts. Handles DST. */
export function cairoDayStartUtc(day: string): string {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let guess = utcMidnight - cairoOffsetMinutes(new Date(utcMidnight)) * 60_000;
  guess = utcMidnight - cairoOffsetMinutes(new Date(guess)) * 60_000;
  return new Date(guess).toISOString();
}

/** YYYY-MM-DD + n days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Stock overview
// ---------------------------------------------------------------------------

export const STOCK_ALERTS = ["all", "below_reorder", "near_expiry", "expired", "not_sellable"] as const;
export type StockAlert = (typeof STOCK_ALERTS)[number];

export interface StockFlags {
  belowReorder: boolean;
  nearExpiry: boolean;
  expired: boolean;
  notSellable: boolean;
}

export function stockRowFlags(row: StockRow, belowReorder: ReadonlySet<string>): StockFlags {
  return {
    // Reorder is judged on company-wide sellable stock; only sellable rows carry the flag.
    belowReorder: row.is_sellable && belowReorder.has(row.variant_id),
    nearExpiry: row.near_expiry_qty > 0,
    expired: row.expired_qty > 0,
    notSellable: !row.is_sellable,
  };
}

export function matchesAlert(flags: StockFlags, alert: StockAlert): boolean {
  switch (alert) {
    case "below_reorder":
      return flags.belowReorder;
    case "near_expiry":
      return flags.nearExpiry;
    case "expired":
      return flags.expired;
    case "not_sellable":
      return flags.notSellable;
    default:
      return true;
  }
}

/** Overview rows in display order (product, SKU, sellable warehouses first), filtered by alert. */
export function stockOverview(rows: StockRow[], alerts: ReorderAlertRow[], alert: StockAlert) {
  const below = new Set(alerts.map((a) => a.variant_id));
  return rows
    .map((row) => ({ row, flags: stockRowFlags(row, below) }))
    .filter(({ flags }) => matchesAlert(flags, alert))
    .sort(
      (a, b) =>
        a.row.product_name.localeCompare(b.row.product_name) ||
        a.row.sku.localeCompare(b.row.sku) ||
        Number(b.row.is_sellable) - Number(a.row.is_sellable) ||
        a.row.warehouse_code.localeCompare(b.row.warehouse_code),
    );
}

export interface StockSummary {
  belowReorder: number;
  nearExpiryLines: number;
  expiredQty: number;
  notSellableQty: number;
}

export function summarizeStock(rows: StockRow[], alerts: ReorderAlertRow[]): StockSummary {
  return {
    belowReorder: alerts.length,
    nearExpiryLines: rows.filter((r) => r.near_expiry_qty > 0).length,
    expiredQty: rows.reduce((n, r) => n + r.expired_qty, 0),
    notSellableQty: rows.filter((r) => !r.is_sellable).reduce((n, r) => n + Math.max(r.on_hand, 0), 0),
  };
}

/** Lots in FEFO order (earliest expiry first, no expiry last), hiding all-zero balances unless `keepEmpty`. */
export function lotsFefo(rows: StockDetailRow[], opts: { keepEmpty?: boolean } = {}): StockDetailRow[] {
  return rows
    .filter((r) => opts.keepEmpty || r.on_hand !== 0 || r.reserved !== 0)
    .sort((a, b) => {
      if (a.expiry_date !== b.expiry_date) {
        if (a.expiry_date === null) return 1;
        if (b.expiry_date === null) return -1;
        return a.expiry_date.localeCompare(b.expiry_date);
      }
      return a.warehouse_code.localeCompare(b.warehouse_code) || a.lot_no.localeCompare(b.lot_no);
    });
}

export interface Option {
  value: string;
  label: string;
}

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string, ar: string | null | undefined): string {
  return locale === "ar" && ar ? ar : en;
}

export function brandOptions(variants: VariantRow[]): Option[] {
  const seen = new Map<string, string>();
  for (const v of variants) seen.set(v.brand_id, v.brand_name);
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function productOptions(variants: VariantRow[], locale: string, brandId?: string): Option[] {
  const seen = new Map<string, string>();
  for (const v of variants) {
    if (brandId && v.brand_id !== brandId) continue;
    seen.set(v.product_id, localizedName(locale, v.product_name, v.product_name_ar));
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Variant ids matching brand/product filters (for views without a brand column). */
export function variantIdsFor(variants: VariantRow[], filter: { brand?: string; product?: string }): string[] {
  return variants
    .filter((v) => (!filter.brand || v.brand_id === filter.brand) && (!filter.product || v.product_id === filter.product))
    .map((v) => v.variant_id);
}

// ---------------------------------------------------------------------------
// Search-param filters (GET forms; values are untrusted)
// ---------------------------------------------------------------------------

export type SearchParams = Record<string, string | string[] | undefined>;

const guid = z.guid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function first(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s.trim() === "" ? undefined : s.trim();
}

function idParam(sp: SearchParams, key: string): string | undefined {
  const v = first(sp, key);
  return v && guid.safeParse(v).success ? v : undefined;
}

function enumParam<T extends string>(sp: SearchParams, key: string, allowed: readonly T[]): T | undefined {
  const v = first(sp, key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export interface StockFilters {
  warehouse?: string;
  brand?: string;
  product?: string;
  alert: StockAlert;
}

export function parseStockFilters(sp: SearchParams): StockFilters {
  return {
    warehouse: idParam(sp, "warehouse"),
    brand: idParam(sp, "brand"),
    product: idParam(sp, "product"),
    alert: enumParam(sp, "alert", STOCK_ALERTS) ?? "all",
  };
}

export interface MovementFilters {
  warehouse?: string;
  variant?: string;
  type?: MovementType;
  sourceType?: string;
  sourceId?: string;
  from?: string;
  to?: string;
  /** Keyset cursor: created_at (as sent by the database) and id of the last row shown. */
  before?: string;
  beforeId?: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

export function parseMovementFilters(sp: SearchParams): MovementFilters {
  const from = first(sp, "from");
  const to = first(sp, "to");
  const before = first(sp, "before");
  const beforeId = idParam(sp, "before_id");
  const cursor = before && beforeId && TIMESTAMP.test(before) ? { before, beforeId } : {};
  return {
    warehouse: idParam(sp, "warehouse"),
    variant: idParam(sp, "variant"),
    type: enumParam(sp, "type", MOVEMENT_TYPES),
    sourceType: enumParam(sp, "source_type", ["receipt", "transfer", "adjustment", "fulfillment", "return"] as const),
    sourceId: idParam(sp, "source_id"),
    from: from && day.safeParse(from).success ? from : undefined,
    to: to && day.safeParse(to).success ? to : undefined,
    ...cursor,
  };
}

/** Query string for links (drops empty values). */
export function toQuery(params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Movements (read-only ledger)
// ---------------------------------------------------------------------------

export function movementTone(type: MovementType): BadgeTone {
  switch (type) {
    case "receipt":
    case "sale_return":
    case "transfer_in":
    case "adjustment_in":
      return "success";
    case "damage":
    case "expiry_writeoff":
    case "adjustment_out":
      return "danger";
    case "reversal":
      return "warning";
    default:
      return "info";
  }
}

export function isMovementType(v: string): v is MovementType {
  return (MOVEMENT_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export const REASON_CODES = ["count_correction", "found", "damaged", "lost", "expired", "sample", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** The value stored in movements.reason_code: `code` or `code: note`. */
export function composeReason(code: ReasonCode, note?: string | null): string {
  const n = note?.trim();
  return n ? `${code}: ${n}` : code;
}

export function parseReason(text: string | null | undefined): { code: ReasonCode | null; note: string | null } {
  if (!text) return { code: null, note: null };
  const m = /^([a-z_]+)(?::\s*([\s\S]*))?$/.exec(text.trim());
  if (m?.[1] && (REASON_CODES as readonly string[]).includes(m[1])) {
    return { code: m[1] as ReasonCode, note: m[2]?.trim() || null };
  }
  return { code: null, note: text };
}

/** Units the user may adjust per product, warehouse and Cairo day without approval (null = no limit; undefined = not allowed). */
export function adjustmentLimit(ctx: UserContext): number | null | undefined {
  return limitOf(ctx, "inventory.adjustment.post");
}

/** Normalise api.request_inventory_adjustment's jsonb result. */
export function parseAdjustmentResult(data: unknown): {
  outcome: AdjustmentOutcome;
  movementId: string | null;
  approvalRequestId: string | null;
  replayed: boolean;
} {
  const d = (data ?? {}) as Record<string, unknown>;
  const status = String(d.status ?? "");
  const outcome: AdjustmentOutcome = (["posted", "pending_approval", "approved", "rejected", "cancelled"] as const).includes(
    status as AdjustmentOutcome,
  )
    ? (status as AdjustmentOutcome)
    : "pending_approval";
  return {
    // An approved request is posted by the decision hook, so it carries a movement.
    outcome,
    movementId: typeof d.movement_id === "string" ? d.movement_id : null,
    approvalRequestId: typeof d.approval_request_id === "string" ? d.approval_request_id : null,
    replayed: d.replayed === true,
  };
}

/** Signed adjustment quantity from direction + positive amount. */
export function signedQuantity(direction: "in" | "out", quantity: number): number {
  return direction === "out" ? -Math.abs(quantity) : Math.abs(quantity);
}

/** `variant_id:lot_id` select values for stock-line pickers. */
export function stockLineValue(variantId: string, lotId: string): string {
  return `${variantId}:${lotId}`;
}

export function parseStockLineValue(value: string): { variantId: string; lotId: string } | null {
  const [variantId, lotId, extra] = value.split(":");
  if (extra !== undefined || !variantId || !lotId) return null;
  if (!guid.safeParse(variantId).success || !guid.safeParse(lotId).success) return null;
  return { variantId, lotId };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export function receiptStatusTone(status: ReceiptStatus): BadgeTone {
  return status === "posted" ? "success" : status === "cancelled" ? "neutral" : "warning";
}

export function isReceiptStatus(v: string): v is ReceiptStatus {
  return (RECEIPT_STATUSES as readonly string[]).includes(v);
}

export type ReceiptLineIssue = "EXPIRY_REQUIRED" | "EXPIRED_NEEDS_QUARANTINE";

/**
 * Early warnings the database would raise on create/post: an expiry is required
 * for expiry-tracked products, and expired goods may only be received into quarantine.
 */
export function receiptLineIssues(
  line: { expiry_date?: string | null },
  opts: { expiryTracked: boolean; warehouseKind: WarehouseKind | null | undefined; today: string },
): ReceiptLineIssue[] {
  const issues: ReceiptLineIssue[] = [];
  if (opts.expiryTracked && !line.expiry_date) issues.push("EXPIRY_REQUIRED");
  if (line.expiry_date && line.expiry_date < opts.today && opts.warehouseKind !== "quarantine") issues.push("EXPIRED_NEEDS_QUARANTINE");
  return issues;
}

export function canReadReceipts(ctx: UserContext): boolean {
  return canAny(ctx, ["inventory.receipt.post", "inventory.movement.read"]);
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function transferStatusTone(status: TransferStatus): BadgeTone {
  switch (status) {
    case "received":
      return "success";
    case "in_transit":
      return "info";
    case "cancelled":
      return "neutral";
    default:
      return "warning";
  }
}

export function isTransferStatus(v: string): v is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(v);
}

export function canReadTransfers(ctx: UserContext): boolean {
  return canAny(ctx, ["inventory.transfer.create", "inventory.transfer.receive", "inventory.movement.read"]);
}

/** Which actions to offer on a transfer (the DB re-checks the warehouse scope). */
export function transferActions(ctx: UserContext, t: Pick<TransferRow, "status">): { ship: boolean; receive: boolean } {
  return {
    ship: can(ctx, "inventory.transfer.create") && (t.status === "draft" || t.status === "approved"),
    receive: can(ctx, "inventory.transfer.receive") && t.status === "in_transit",
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Business codes with their own text under inventory.errors.* */
export const INVENTORY_ERROR_CODES = [
  "INSUFFICIENT_STOCK",
  "EXPIRED_LOT",
  "LOT_EXPIRY_MISMATCH",
  "WAREHOUSE_NOT_SELLABLE",
  "APPROVAL_REQUIRED",
  "NO_LINES",
  "SAME_WAREHOUSE",
] as const;
export type InventoryErrorCode = (typeof INVENTORY_ERROR_CODES)[number];

/** Which message to show: the inventory-specific text if there is one, else the shared errors.* text. */
export function errorMessageRef(code: string, messageKey: string): { namespace: "inventory.errors" | "errors"; key: string } {
  if ((INVENTORY_ERROR_CODES as readonly string[]).includes(code)) return { namespace: "inventory.errors", key: code };
  const key = (TRANSLATED_CODES as readonly string[]).includes(messageKey) ? messageKey : "UNKNOWN";
  return { namespace: "errors", key };
}

/** First 8 characters of an id, for compact references. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}

/** numeric(14,2) from PostgREST → number | null. */
export function toAmount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
