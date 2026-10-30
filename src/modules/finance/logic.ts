import { can, limitOf, type UserContext } from "@/lib/authz/can";
import type { AppError } from "@/lib/errors";
import type {
  AgingBucket,
  CollectionAction,
  CollectionStatus,
  InvoiceRow,
  InvoiceStatus,
  Numeric,
  PaymentRow,
  PaymentStatus,
  StatementRow,
} from "./types";
import { AGING_BUCKETS } from "./types";

/**
 * Pure finance logic for the UI: filters, which actions to offer, money
 * arithmetic for previews, and statement periods. Offering an action is
 * cosmetic — every api.* command re-checks permission, scope, status and
 * amounts in Postgres (supabase/migrations/20261031000100_finance_ar_commands.sql).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export const FINANCE_ERROR_CODES = [
  "NOTHING_TO_INVOICE",
  "IDEMPOTENCY_CONFLICT",
  "EXCEEDS_INVOICE_OPEN_AMOUNT",
  "CREDIT_QTY_EXCEEDED",
  "OVER_ALLOCATION",
  "INVOICE_CLOSED",
  "NOTHING_TO_ALLOCATE",
  "LIMIT_EXCEEDED",
  "SELF_APPROVAL",
  "WORKFLOW_MISSING",
  "INVOICE_IMMUTABLE",
  "INVOICE_STILL_OPEN",
  "WRITE_OFF_PENDING",
  "REASON_REQUIRED",
  "INVALID_STATE",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "VALIDATION",
  "DUPLICATE",
  "CONFLICT",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type FinanceErrorCode = (typeof FINANCE_ERROR_CODES)[number];

const isFinanceErrorCode = (code: string): code is FinanceErrorCode => (FINANCE_ERROR_CODES as readonly string[]).includes(code);

/** Which finance.errors.* message to show for a failed command or read. */
export function financeErrorCode(error: Pick<AppError, "code" | "messageKey">): FinanceErrorCode {
  if (isFinanceErrorCode(error.code)) return error.code;
  if (isFinanceErrorCode(error.messageKey)) return error.messageKey;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Numbers and money. Previews work in whole cents so 0.1 + 0.2 never drifts;
// the server recomputes every amount anyway.
// ---------------------------------------------------------------------------
/** numeric from PostgREST (number or string) → number; NaN-safe. */
export function toNumber(value: Numeric | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export const toCents = (value: Numeric | null | undefined): number => Math.round(toNumber(value) * 100);
export const fromCents = (cents: number): number => cents / 100;

/** Largest amount accepted by api.record_payment. */
export const MAX_AMOUNT = 100_000_000;
const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/** User-typed amount ("1250", "1250.5", "1,250.50", Arabic-Indic digits) → number, or null if invalid / not positive. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = normalizeDigits(raw).replace(/[,\s\u066C]/g, "").replace("\u066B", ".");
  if (!AMOUNT_PATTERN.test(text)) return null;
  const value = Number(text);
  if (!(value > 0) || value > MAX_AMOUNT) return null;
  return value;
}

/** Arabic-Indic and Persian digits → ASCII digits (reps may type either). */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

export function invoiceStatusTone(status: InvoiceStatus, overdue = false): BadgeTone {
  if (overdue) return "danger";
  switch (status) {
    case "paid":
      return "success";
    case "partially_paid":
      return "warning";
    case "credited":
    case "written_off":
      return "neutral";
    default:
      return "info";
  }
}

export function paymentStatusTone(status: PaymentStatus): BadgeTone {
  switch (status) {
    case "confirmed":
      return "success";
    case "pending_verification":
      return "warning";
    case "bounced":
      return "danger";
    default:
      return "neutral";
  }
}

export function collectionStatusTone(status: CollectionStatus, promiseBroken = false): BadgeTone {
  if (promiseBroken) return "danger";
  switch (status) {
    case "promised":
      return "info";
    case "escalated":
      return "danger";
    case "collected":
      return "success";
    case "closed":
      return "neutral";
    default:
      return "warning";
  }
}

// ---------------------------------------------------------------------------
// List filters (from the URL; anything unknown falls back to the default)
// ---------------------------------------------------------------------------
export const INVOICE_FILTERS = {
  open: ["issued", "partially_paid"],
  overdue: ["issued", "partially_paid"],
  paid: ["paid"],
  credited: ["credited", "written_off"],
  all: [],
} as const satisfies Record<string, readonly InvoiceStatus[]>;
export type InvoiceFilter = keyof typeof INVOICE_FILTERS;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseInvoiceFilter(value: string | string[] | undefined): InvoiceFilter {
  const v = first(value);
  return v && Object.hasOwn(INVOICE_FILTERS, v) ? (v as InvoiceFilter) : "open";
}

export const PAYMENT_FILTERS = {
  pending: ["pending_verification"],
  unallocated: ["confirmed"],
  confirmed: ["confirmed"],
  closed: ["bounced", "reversed"],
  all: [],
} as const satisfies Record<string, readonly PaymentStatus[]>;
export type PaymentFilter = keyof typeof PAYMENT_FILTERS;

export function parsePaymentFilter(value: string | string[] | undefined, fallback: PaymentFilter = "all"): PaymentFilter {
  const v = first(value);
  return v && Object.hasOwn(PAYMENT_FILTERS, v) ? (v as PaymentFilter) : fallback;
}

export const COLLECTION_FILTERS = {
  active: ["open", "promised", "escalated"],
  promised: ["promised"],
  escalated: ["escalated"],
  done: ["collected", "closed"],
  all: [],
} as const satisfies Record<string, readonly CollectionStatus[]>;
export type CollectionFilter = keyof typeof COLLECTION_FILTERS;

export function parseCollectionFilter(value: string | string[] | undefined): CollectionFilter {
  const v = first(value);
  return v && Object.hasOwn(COLLECTION_FILTERS, v) ? (v as CollectionFilter) : "active";
}

export function parseBucket(value: string | string[] | undefined): AgingBucket | null {
  const v = first(value);
  return v && (AGING_BUCKETS as readonly string[]).includes(v) ? (v as AgingBucket) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

export function parseUuid(value: string | string[] | undefined): string | null {
  const v = first(value);
  return isUuid(v) ? v.toLowerCase() : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD that is a real calendar date, else null. */
export function parseIsoDate(value: string | string[] | undefined): string | null {
  const v = first(value);
  if (!v || !ISO_DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

/** Today in Africa/Cairo as YYYY-MM-DD (the business day, like core.business_date()). */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// ---------------------------------------------------------------------------
// Which actions to offer (mirrors the checks in the api.* commands)
// ---------------------------------------------------------------------------
export interface PaymentActions {
  confirm: boolean;
  reject: boolean;
  allocate: boolean;
  reverse: boolean;
}

export function paymentActions(ctx: UserContext, payment: Pick<PaymentRow, "status" | "unallocated">): PaymentActions {
  const pending = payment.status === "pending_verification";
  const confirmed = payment.status === "confirmed";
  return {
    confirm: pending && can(ctx, "finance.payment.confirm"),
    reject: pending && can(ctx, "finance.payment.confirm"),
    allocate: confirmed && toCents(payment.unallocated) > 0 && can(ctx, "finance.payment.allocate"),
    reverse: confirmed && can(ctx, "finance.payment.reverse"),
  };
}

export const isInvoiceOpen = (invoice: Pick<InvoiceRow, "status" | "open_amount">): boolean =>
  (invoice.status === "issued" || invoice.status === "partially_paid") && toCents(invoice.open_amount) > 0;

export function canCreditInvoice(ctx: UserContext, invoice: Pick<InvoiceRow, "status" | "open_amount">): boolean {
  return invoice.status !== "written_off" && toCents(invoice.open_amount) > 0 && can(ctx, "finance.credit_note.issue");
}

/**
 * Request a write-off (api.request_invoice_write_off): finance.collection.manage, an open
 * invoice, and no write-off of it already waiting for a decision. UX only; Postgres decides.
 */
export function canWriteOffInvoice(
  ctx: UserContext,
  invoice: Pick<InvoiceRow, "status" | "open_amount">,
  pendingRequests: number,
): boolean {
  return isInvoiceOpen(invoice) && pendingRequests === 0 && can(ctx, "finance.collection.manage");
}

export type WriteOffCheck = { ok: true; amount: number } | { ok: false; reason: "invalidAmount" | "exceedsOpen" };

/** Client-side check of a typed write-off amount against the invoice's open amount (the server re-checks). */
export function checkWriteOffAmount(raw: string, openAmount: Numeric): WriteOffCheck {
  const amount = parseAmount(raw);
  if (amount === null) return { ok: false, reason: "invalidAmount" };
  if (Math.round(amount * 100) > toCents(openAmount)) return { ok: false, reason: "exceedsOpen" };
  return { ok: true, amount };
}

/** Actions api.update_collection_task accepts from a status. */
export function collectionActions(status: CollectionStatus): CollectionAction[] {
  switch (status) {
    case "open":
      return ["promise", "escalate", "collected", "close"];
    case "promised":
      return ["promise", "reopen", "escalate", "collected", "close"];
    case "escalated":
      return ["promise", "reopen", "collected", "close"];
    default:
      return [];
  }
}

/** Actions the assignee (a rep without finance.collection.manage) may take: record a promise or escalate. */
export const ASSIGNEE_COLLECTION_ACTIONS: readonly CollectionAction[] = ["promise", "escalate"];

/**
 * Actions to offer this user on this task (mirrors api.update_collection_task):
 *   finance.collection.manage → every action of the status, but "collected" only once nothing is
 *     open on the invoice (a task without an invoice is checked against the balance on the server)
 *   the assignee              → only "promise" and "escalate"
 */
export function collectionActionsFor(
  ctx: UserContext,
  task: { status: CollectionStatus; assignee_employee_id: string; invoice_open_amount: Numeric | null },
): CollectionAction[] {
  const byStatus = collectionActions(task.status);
  if (can(ctx, "finance.collection.manage")) {
    const settled = task.invoice_open_amount === null || toCents(task.invoice_open_amount) <= 0;
    return byStatus.filter((a) => a !== "collected" || settled);
  }
  if (canManageCollection(ctx, task)) return byStatus.filter((a) => ASSIGNEE_COLLECTION_ACTIONS.includes(a));
  return [];
}

/** api.update_collection_task: finance.collection.manage in scope, or the assignee with work.task.manage. */
export function canManageCollection(ctx: UserContext, task: { assignee_employee_id: string }): boolean {
  if (can(ctx, "finance.collection.manage")) return true;
  return ctx.employee !== null && ctx.employee.id === task.assignee_employee_id && can(ctx, "work.task.manage");
}

export const COLLECTION_NOTE_REQUIRED: readonly CollectionAction[] = ["escalate", "close"];

// ---------------------------------------------------------------------------
// Allocation previews
// ---------------------------------------------------------------------------
export interface OpenInvoice {
  id: string;
  invoice_no: string;
  due_date: string;
  issue_date: string;
  open_amount: Numeric;
}

export interface AllocationLine {
  invoice_id: string;
  amount: number;
}

/** What api.allocate_payment(p_allocations = NULL) would do: oldest due first. */
export function fifoPreview(invoices: readonly OpenInvoice[], unallocated: Numeric): AllocationLine[] {
  let left = toCents(unallocated);
  const sorted = [...invoices].sort(
    (a, b) => a.due_date.localeCompare(b.due_date) || a.issue_date.localeCompare(b.issue_date) || a.invoice_no.localeCompare(b.invoice_no),
  );
  const out: AllocationLine[] = [];
  for (const inv of sorted) {
    if (left <= 0) break;
    const open = toCents(inv.open_amount);
    if (open <= 0) continue;
    const take = Math.min(open, left);
    out.push({ invoice_id: inv.id, amount: fromCents(take) });
    left -= take;
  }
  return out;
}

export type AllocationCheck =
  | { ok: true; lines: AllocationLine[]; total: number }
  | { ok: false; reason: "empty" | "invalidAmount" | "exceedsInvoice" | "exceedsPayment" | "exceedsLimit" | "unknownInvoice"; invoiceId?: string };

/**
 * Validate manual allocation inputs before sending (the command re-checks under row locks).
 * `inputs` maps invoice id → typed amount; blank entries are skipped. `limit` = the user's
 * finance.payment.allocate limit (null = unlimited).
 */
export function checkAllocations(
  inputs: Readonly<Record<string, string>>,
  invoices: readonly OpenInvoice[],
  unallocated: Numeric,
  limit: number | null | undefined = null,
): AllocationCheck {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const lines: AllocationLine[] = [];
  let total = 0;
  for (const [id, raw] of Object.entries(inputs)) {
    if (raw.trim() === "") continue;
    const inv = byId.get(id);
    if (!inv) return { ok: false, reason: "unknownInvoice", invoiceId: id };
    const amount = parseAmount(raw);
    if (amount === null) return { ok: false, reason: "invalidAmount", invoiceId: id };
    const cents = Math.round(amount * 100);
    if (cents > toCents(inv.open_amount)) return { ok: false, reason: "exceedsInvoice", invoiceId: id };
    lines.push({ invoice_id: id, amount });
    total += cents;
  }
  if (lines.length === 0) return { ok: false, reason: "empty" };
  if (total > toCents(unallocated)) return { ok: false, reason: "exceedsPayment" };
  if (limit !== null && limit !== undefined && total > Math.round(limit * 100)) return { ok: false, reason: "exceedsLimit" };
  return { ok: true, lines, total: fromCents(total) };
}

/** The user's per-command allocation limit in EGP: null = unlimited, undefined = not held. */
export const allocationLimit = (ctx: UserContext): number | null | undefined => limitOf(ctx, "finance.payment.allocate");

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------
export interface CreditableLine {
  invoice_item_id: string;
  quantity: number;
  credited_qty: number;
}

export const creditableQty = (line: CreditableLine): number => Math.max(line.quantity - line.credited_qty, 0);

export type CreditLinesCheck =
  | { ok: true; lines: { invoice_item_id: string; quantity: number }[] }
  | { ok: false; reason: "empty" | "invalidQty" | "exceedsQty"; invoiceItemId?: string };

/** Quantity inputs per invoice line → credit lines (whole, positive, within what is still creditable). */
export function checkCreditLines(inputs: Readonly<Record<string, string>>, lines: readonly CreditableLine[]): CreditLinesCheck {
  const byId = new Map(lines.map((l) => [l.invoice_item_id, l]));
  const out: { invoice_item_id: string; quantity: number }[] = [];
  for (const [id, raw] of Object.entries(inputs)) {
    const text = normalizeDigits(raw).trim();
    if (text === "" || text === "0") continue;
    const line = byId.get(id);
    if (!line || !/^\d{1,6}$/.test(text)) return { ok: false, reason: "invalidQty", invoiceItemId: id };
    const qty = Number(text);
    if (qty > creditableQty(line)) return { ok: false, reason: "exceedsQty", invoiceItemId: id };
    out.push({ invoice_item_id: id, quantity: qty });
  }
  return out.length === 0 ? { ok: false, reason: "empty" } : { ok: true, lines: out };
}

// ---------------------------------------------------------------------------
// Statement period
// ---------------------------------------------------------------------------
export interface StatementPeriod {
  opening: number;
  closing: number;
  debit: number;
  credit: number;
  rows: StatementRow[];
}

/**
 * Rows of [from, to] (Cairo dates, inclusive; either may be null), with the opening balance
 * before the period and the closing balance at its end. Rows must be in ledger order (oldest
 * first) and may be only the latest part of the ledger; each row's running_balance is the true
 * balance after it (computed in the view over all rows).
 */
export function statementPeriod(rows: readonly StatementRow[], from: string | null, to: string | null): StatementPeriod {
  let before: number | null = null;
  const inPeriod: StatementRow[] = [];
  for (const row of rows) {
    if (from && row.posted_date < from) {
      before = toCents(row.running_balance);
      continue;
    }
    if (to && row.posted_date > to) break;
    inPeriod.push(row);
  }
  // Without an earlier row (none, or older rows not loaded) the opening balance is the
  // first row's running balance before that row.
  const firstRow = inPeriod[0];
  const lastRow = inPeriod[inPeriod.length - 1];
  const opening = before ?? (firstRow ? toCents(firstRow.running_balance) - toCents(firstRow.amount) : 0);
  const debit = inPeriod.reduce((s, r) => s + toCents(r.debit), 0);
  const credit = inPeriod.reduce((s, r) => s + toCents(r.credit), 0);
  const closing = lastRow ? toCents(lastRow.running_balance) : opening;
  return { opening: fromCents(opening), closing: fromCents(closing), debit: fromCents(debit), credit: fromCents(credit), rows: inPeriod };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
/** Cairo calendar day (YYYY-MM-DD) of an instant, or null if it is not a valid time. */
export function cairoDay(at: string | Date): string | null {
  const d = typeof at === "string" ? new Date(at) : at;
  return Number.isNaN(d.getTime()) ? null : cairoToday(d);
}

/**
 * How many Cairo days before it was recorded a payment says it was received (0 = same day).
 * Finance double-checks a back-dated payment before confirming it (api.record_payment bounds it).
 */
export function receivedDaysBeforeRecording(receivedAt: string, recordedAt: string): number {
  const received = cairoDay(receivedAt);
  const recorded = cairoDay(recordedAt);
  if (!received || !recorded) return 0;
  return Math.max(daysBetween(received, recorded), 0);
}

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

/** Route of the document a ledger row came from, or null. */
export function documentHref(row: Pick<StatementRow, "source_table" | "source_id">): string | null {
  if (!isUuid(row.source_id)) return null;
  if (row.source_table === "finance.invoices") return `/finance/invoices/${row.source_id}`;
  if (row.source_table === "finance.payments") return `/finance/payments/${row.source_id}`;
  return null;
}

/** Days from `from` to `to` (YYYY-MM-DD), negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Path plus a query string of the defined values only (filter links). */
export function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
