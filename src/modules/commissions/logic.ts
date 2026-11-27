import type { AppError } from "@/lib/errors";
import type {
  DbNumber,
  LineKind,
  PeriodRow,
  PeriodStatus,
  PlanStatus,
  RateTarget,
  RequestStatus,
  RuleRow,
  RuleState,
  StatementLine,
  StatementTotalsRow,
  SummaryRow,
  UnratedRow,
} from "./types";
import { sharedStatusTone } from "@/lib/status-tone";

/**
 * Pure helpers for the commission screens. Every amount comes from Postgres; these
 * only pick months, labels and tones. Months are Cairo calendar months, written
 * as "YYYY-MM" in URLs and forms.
 */

export const CAIRO_TZ = "Africa/Cairo";

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Today in Cairo as YYYY-MM-DD. */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isMonthKey(value: string): boolean {
  const m = MONTH_KEY.exec(value);
  return m !== null && Number(m[1]) >= 2000 && Number(m[1]) <= 2100;
}

/** YYYY-MM of a YYYY-MM-DD (or longer ISO) date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** First day of a month key, as the DB takes it (YYYY-MM-01). */
export function monthStart(key: string): string {
  return `${key}-01`;
}

function splitKey(key: string): [number, number] {
  return [Number(key.slice(0, 4)), Number(key.slice(5, 7))];
}

/** Last day of a month key (YYYY-MM-DD). */
export function monthEnd(key: string): string {
  const [y, m] = splitKey(key);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${key}-${String(last).padStart(2, "0")}`;
}

export function addMonths(key: string, n: number): string {
  const [y, m] = splitKey(key);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `?period=` → a month key no later than the current month; anything else → the current month. */
export function resolveMonth(value: string | string[] | undefined, today: string): string {
  const v = Array.isArray(value) ? value[0] : value;
  const current = monthOf(today);
  if (v === undefined || !isMonthKey(v)) return current;
  return v > current ? current : v;
}

/** The current month and the `count − 1` before it, newest first. */
export function recentMonths(today: string, count = 12): string[] {
  const current = monthOf(today);
  return Array.from({ length: Math.max(count, 1) }, (_, i) => addMonths(current, -i));
}

export function isFrozen(status: PeriodStatus | null | undefined): boolean {
  return status === "approved" || status === "paid" || status === "locked";
}

/** Display status of a month: no row yet means nothing was calculated (open). */
export function displayStatus(status: PeriodStatus | null | undefined): "open" | "calculated" | "closed" {
  if (isFrozen(status)) return "closed";
  return status === "calculated" ? "calculated" : "open";
}

export function statusTone(status: PeriodStatus | null | undefined): "neutral" | "info" | "success" {
  const s = displayStatus(status);
  return s === "closed" ? "success" : s === "calculated" ? "info" : "neutral";
}

export function requestTone(status: RequestStatus): "neutral" | "warning" | "success" | "danger" {
  const shared = sharedStatusTone(status);
  if (shared === "warning" || shared === "danger" || shared === "neutral" || shared === "success") return shared;
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "neutral";
}

/** Earning lines are positive by design; clawbacks and reversals reduce the statement. */
export function kindTone(kind: LineKind): "success" | "danger" | "info" | "warning" {
  switch (kind) {
    case "collection":
    case "credit_reattribution":
      return "success";
    case "reversal":
    case "bounce":
    case "credit_clawback":
      return "danger";
    case "bonus":
      return "info";
    default:
      return "warning";
  }
}

/** numeric from PostgREST (number or string) → number; NaN-safe. */
export function toNumber(value: DbNumber | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Footer of the team table: the sum of the per-employee rows the server returned, in whole
 * cents so it never drifts. (Each row is computed in Postgres; this only adds them up.)
 */
export function sumSummary(rows: readonly Pick<SummaryRow, "earned" | "clawed_back" | "adjustments" | "total">[]) {
  const cents = (v: DbNumber) => Math.round((toNumber(v) ?? 0) * 100);
  const acc = { earned: 0, clawed: 0, adjustments: 0, total: 0 };
  for (const r of rows) {
    acc.earned += cents(r.earned);
    acc.clawed += cents(r.clawed_back);
    acc.adjustments += cents(r.adjustments);
    acc.total += cents(r.total);
  }
  return { earned: acc.earned / 100, clawed: acc.clawed / 100, adjustments: acc.adjustments / 100, total: acc.total / 100 };
}

/** Statement lines in reading order: newest event first, adjustments with their day. */
export function sortLines(lines: readonly StatementLine[]): StatementLine[] {
  return [...lines].sort((a, b) => (a.event_at === b.event_at ? a.id.localeCompare(b.id) : a.event_at < b.event_at ? 1 : -1));
}

/**
 * The month finance can close now: the oldest month that is not closed, once it has
 * ended. `periods` is api.v_commission_periods; months without a row count as open.
 * Postgres re-checks all of it (PREVIOUS_PERIOD_OPEN, PERIOD_NOT_ENDED).
 */
export function closableMonth(periods: readonly Pick<PeriodRow, "period_start" | "status">[], today: string): string | null {
  const current = monthOf(today);
  const frozen = periods.filter((p) => isFrozen(p.status)).map((p) => monthOf(p.period_start)).sort();
  const lastFrozen = frozen.at(-1);
  const open = periods.filter((p) => !isFrozen(p.status)).map((p) => monthOf(p.period_start)).sort();
  const oldest = lastFrozen ? addMonths(lastFrozen, 1) : open[0];
  if (!oldest || oldest >= current) return null;
  return oldest;
}

/** Months finance may recalculate: every open month from the oldest open one to the current month. */
export function recalculableMonths(periods: readonly Pick<PeriodRow, "period_start" | "status">[], today: string): string[] {
  const current = monthOf(today);
  const frozen = periods.filter((p) => isFrozen(p.status)).map((p) => monthOf(p.period_start)).sort();
  const lastFrozen = frozen.at(-1);
  const open = periods.filter((p) => !isFrozen(p.status)).map((p) => monthOf(p.period_start)).sort();
  let m = lastFrozen ? addMonths(lastFrozen, 1) : (open[0] ?? current);
  if (m > current) return [];
  const out: string[] = [];
  while (m <= current && out.length < 24) {
    out.push(m);
    m = addMonths(m, 1);
  }
  return out;
}

/** Periods table rows, newest first, with the current month shown even before its first calculation. */
export function periodRows(periods: readonly PeriodRow[], today: string): Array<PeriodRow | { period_start: string; missing: true }> {
  const current = monthStart(monthOf(today));
  const rows: Array<PeriodRow | { period_start: string; missing: true }> = [...periods];
  if (!periods.some((p) => p.period_start === current)) rows.push({ period_start: current, missing: true });
  return rows.sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
}

/** Amount input → number with at most 2 decimals, non-zero, |x| ≤ 1,000,000; else null. Accepts Arabic-Indic digits. */
export function parseSignedAmount(raw: string): number | null {
  const ascii = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, ".")
    .replace(/[−]/g, "-")
    .replace(/[,٬\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(ascii)) return null;
  const n = Number(ascii);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 1_000_000) return null;
  return n;
}

/** A bonus is positive and a clawback negative (the DB refuses the rest too). */
export function kindMatchesSign(kind: "bonus" | "clawback" | "correction", amount: number): boolean {
  if (kind === "bonus") return amount > 0;
  if (kind === "clawback") return amount < 0;
  return amount !== 0;
}

// ---------------------------------------------------------------------------
// Rate editor
// ---------------------------------------------------------------------------
const DAY_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** A real calendar day as YYYY-MM-DD (2000–2100). */
export function isDayKey(value: string): boolean {
  const m = DAY_KEY.exec(value);
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]);
}

/** Rate input → a percentage 0–100 with at most 2 decimals; else null. Accepts Arabic-Indic digits and a trailing %. */
export function parseRatePct(raw: string): number | null {
  const ascii = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, ".")
    .replace(/[%٪\s]/g, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(ascii)) return null;
  const n = Number(ascii);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function planStatusTone(status: PlanStatus): "neutral" | "success" | "warning" {
  if (status === "active") return "success";
  if (status === "draft") return "warning";
  return "neutral";
}

export function ruleStateTone(state: RuleState): "success" | "info" | "neutral" | "danger" {
  if (state === "current") return "success";
  if (state === "scheduled") return "info";
  if (state === "void") return "danger";
  return "neutral";
}

/** Rates can be changed on drafts and active plans; a retired plan is history. */
export function canEditPlan(status: PlanStatus): boolean {
  return status !== "retired";
}

const TARGET_ORDER: Record<RateTarget, number> = { variant: 0, category: 1, brand: 2, default: 3 };

/**
 * Rates that apply today or later (current and scheduled), most specific target first
 * (product > category > brand > plan default, as the engine resolves them), then by code
 * and start. Ended and void rows are history and are listed apart.
 */
export function liveRules(rules: readonly RuleRow[]): RuleRow[] {
  return rules
    .filter((r) => r.state === "current" || r.state === "scheduled")
    .sort(
      (a, b) =>
        TARGET_ORDER[a.target_type] - TARGET_ORDER[b.target_type] ||
        (a.target_code ?? "").localeCompare(b.target_code ?? "") ||
        (a.effective_from ?? "").localeCompare(b.effective_from ?? ""),
    );
}

/** History rows (ended and void), newest start first. */
export function historyRules(rules: readonly RuleRow[]): RuleRow[] {
  return rules
    .filter((r) => r.state === "ended" || r.state === "void")
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? "") || b.created_at.localeCompare(a.created_at));
}

export interface UnratedGroup {
  brandId: string;
  brandCode: string;
  brandName: string;
  items: UnratedRow[];
}

/** The "no rate" list grouped by brand (the owner usually sets a brand rate first). */
export function groupUnrated(rows: readonly UnratedRow[]): UnratedGroup[] {
  const groups = new Map<string, UnratedGroup>();
  for (const row of rows) {
    const g = groups.get(row.brand_code) ?? { brandId: row.brand_id, brandCode: row.brand_code, brandName: row.brand_name, items: [] };
    g.items.push(row);
    groups.set(row.brand_code, g);
  }
  return [...groups.values()].sort((a, b) => a.brandCode.localeCompare(b.brandCode));
}

// ---------------------------------------------------------------------------
// Rep statement
// ---------------------------------------------------------------------------
export type FunnelKey = "collected" | "vat" | "commissionable" | "unrated" | "commission" | "clawbacks" | "adjustments" | "net";

export interface FunnelStep {
  key: FunnelKey;
  value: number;
  /** A sub-line (shown indented): the VAT taken out, the part without a rate. */
  detail: boolean;
}

/**
 * The statement's steps in reading order: collected cash → VAT out → commissionable →
 * (of which without a rate) → commission → clawbacks → adjustments → net. Every figure comes
 * from api.v_commission_statement_totals; only the order and the sign of the VAT line are
 * decided here. No row → all zeros.
 */
export function statementFunnel(row: StatementTotalsRow | null): FunnelStep[] {
  const n = (v: DbNumber | undefined) => toNumber(v) ?? 0;
  return [
    { key: "collected", value: n(row?.collected_gross), detail: false },
    { key: "vat", value: 0 - n(row?.vat_amount), detail: true },
    { key: "commissionable", value: n(row?.commissionable), detail: false },
    { key: "unrated", value: n(row?.unrated_base), detail: true },
    { key: "commission", value: n(row?.commission), detail: false },
    { key: "clawbacks", value: n(row?.clawbacks), detail: false },
    { key: "adjustments", value: n(row?.adjustments), detail: false },
    { key: "net", value: n(row?.net), detail: false },
  ];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export const COMMISSION_ERROR_CODES = [
  "PERMISSION_DENIED",
  "VALIDATION",
  "NOT_FOUND",
  "INVALID_STATE",
  "PERIOD_CLOSED",
  "PERIOD_NOT_ENDED",
  "PREVIOUS_PERIOD_OPEN",
  "SELF_ADJUSTMENT",
  "REASON_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "CONFLICT",
  "UNAVAILABLE",
  "MFA_REQUIRED",
  "DUPLICATE",
  "COMMISSION_RULE_IMMUTABLE",
  "COMMISSION_PLAN_IMMUTABLE",
  "UNKNOWN",
] as const;
export type CommissionErrorCode = (typeof COMMISSION_ERROR_CODES)[number];

const isCommissionErrorCode = (code: string): code is CommissionErrorCode => (COMMISSION_ERROR_CODES as readonly string[]).includes(code);

/** Which commissions.errors.* message to show for a failed command or read. */
export function commissionErrorCode(error: Pick<AppError, "code"> & Partial<Pick<AppError, "messageKey">>): CommissionErrorCode {
  if (isCommissionErrorCode(error.code)) return error.code;
  if (error.messageKey && isCommissionErrorCode(error.messageKey)) return error.messageKey;
  return "UNKNOWN";
}
