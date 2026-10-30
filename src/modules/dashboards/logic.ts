import type { AppError } from "@/lib/errors";
import type { Grant, UserContext } from "@/lib/authz/can";
import type {
  BreakdownRow,
  DashboardScope,
  DbNumber,
  KpiCode,
  KpiRow,
  KpiStatus,
  KpiUnit,
  Period,
  PeriodKind,
  TeamRow,
} from "./types";
import { PERIOD_KINDS } from "./types";

/**
 * Pure dashboard logic: Cairo-calendar periods, status against target, pivots and
 * display helpers. No I/O, so it is unit-tested (tests/unit/dashboards-logic.test.ts).
 */

export const CAIRO_TZ = "Africa/Cairo";
/** Same bound as perf.check_period in Postgres. */
export const MAX_PERIOD_DAYS = 366;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's date in Cairo (DST-aware), whatever the server's time zone. */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days from `from` to `to` (to − from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * The Sunday–Thursday working week containing `today`. On Friday and Saturday
 * (the weekend) it is the week that just ended.
 */
export function workWeek(today: string): { from: string; to: string } {
  const from = addDays(today, -dayOfWeek(today));
  return { from, to: addDays(from, 4) };
}

export function monthRange(today: string): { from: string; to: string } {
  const from = `${today.slice(0, 7)}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}

export interface PeriodInput {
  period?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Period from the URL. Unknown kinds fall back to this month; a custom range must be
 * two valid dates, in order, at most MAX_PERIOD_DAYS long (`invalid` tells the page).
 */
export function resolvePeriod(input: PeriodInput, today: string): Period & { invalid: boolean } {
  const raw = first(input.period);
  const kind: PeriodKind = raw && (PERIOD_KINDS as readonly string[]).includes(raw) ? (raw as PeriodKind) : "month";
  if (kind === "today") return { kind, from: today, to: today, invalid: false };
  if (kind === "week") return { kind, ...workWeek(today), invalid: false };
  if (kind === "custom") {
    const from = first(input.from) ?? "";
    const to = first(input.to) ?? "";
    if (isIsoDate(from) && isIsoDate(to) && from <= to && daysBetween(from, to) <= MAX_PERIOD_DAYS) {
      return { kind, from, to, invalid: false };
    }
    return { kind: "month", ...monthRange(today), invalid: true };
  }
  return { kind: "month", ...monthRange(today), invalid: false };
}

/** Share of the period already elapsed (today counted), 0…1. */
export function elapsedFraction(period: Pick<Period, "from" | "to">, today: string): number {
  if (today < period.from) return 0;
  if (today >= period.to) return 1;
  return (daysBetween(period.from, today) + 1) / (daysBetween(period.from, period.to) + 1);
}

export function toNumber(value: DbNumber | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Flow KPIs in count/EGP accumulate over the period, so they are judged against pace. */
export function accumulates(row: Pick<KpiRow, "unit" | "is_point_in_time">): boolean {
  return !row.is_point_in_time && (row.unit === "count" || row.unit === "egp");
}

/**
 * Status against target. Accumulating KPIs compare with the target pro-rated to the
 * elapsed share of the period (pace), so mid-month is not "behind" by construction.
 *   higher is better: ≥ 100% of expected → on track · ≥ 80% → at risk · else behind
 *   lower is better:  ≤ target → on track · ≤ 120% of target → at risk · else behind
 */
export function kpiStatus(row: Pick<KpiRow, "unit" | "is_point_in_time" | "higher_is_better" | "value" | "target">, pace: number): KpiStatus | null {
  const value = toNumber(row.value);
  const target = toNumber(row.target);
  if (value === null || target === null || target <= 0) return null;
  if (!row.higher_is_better) {
    if (value <= target) return "onTrack";
    return value <= target * 1.2 ? "atRisk" : "behind";
  }
  const expected = accumulates(row) ? target * Math.min(Math.max(pace, 0), 1) : target;
  if (expected <= 0) return "onTrack";
  const ratio = value / expected;
  if (ratio >= 1) return "onTrack";
  return ratio >= 0.8 ? "atRisk" : "behind";
}

/** Fill of a target meter, 0…100. */
export function meterPercent(value: DbNumber, target: DbNumber): number {
  const v = toNumber(value);
  const t = toNumber(target);
  if (v === null || t === null || t <= 0) return 0;
  return Math.min(Math.max((v / t) * 100, 0), 100);
}

/** Bar length as a % of the largest value; a non-zero value is always visible. */
export function barPercent(value: DbNumber, max: number): number {
  const v = toNumber(value) ?? 0;
  if (max <= 0 || v <= 0) return 0;
  return Math.max((v / max) * 100, 2);
}

export type ValueFormat = "egp" | "count" | "pct" | "decimal";

export function valueFormat(unit: KpiUnit): ValueFormat {
  if (unit === "egp") return "egp";
  if (unit === "pct") return "pct";
  if (unit === "minutes" || unit === "hours" || unit === "ratio") return "decimal";
  return "count";
}

export function byCode(rows: readonly KpiRow[]): Partial<Record<KpiCode, KpiRow>> {
  return Object.fromEntries(rows.map((r) => [r.kpi_code, r])) as Partial<Record<KpiCode, KpiRow>>;
}

export interface TeamMember {
  employee_id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  kpis: Partial<Record<string, Pick<TeamRow, "value" | "target" | "achievement_pct">>>;
}

/** Long rows (employee × KPI) → one entry per employee, in the server's order. */
export function pivotTeam(rows: readonly TeamRow[]): TeamMember[] {
  const out = new Map<string, TeamMember>();
  for (const r of rows) {
    let m = out.get(r.employee_id);
    if (!m) {
      m = { employee_id: r.employee_id, employee_no: r.employee_no, full_name_en: r.full_name_en, full_name_ar: r.full_name_ar, kpis: {} };
      out.set(r.employee_id, m);
    }
    m.kpis[r.kpi_code] = { value: r.value, target: r.target, achievement_pct: r.achievement_pct };
  }
  return [...out.values()];
}

export interface BreakdownEntry {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  values: Partial<Record<string, number>>;
}

export function pivotBreakdown(rows: readonly BreakdownRow[]): BreakdownEntry[] {
  const out = new Map<string, BreakdownEntry>();
  for (const r of rows) {
    let e = out.get(r.dimension_id);
    if (!e) {
      e = { id: r.dimension_id, code: r.dimension_code, name_en: r.name_en, name_ar: r.name_ar, values: {} };
      out.set(r.dimension_id, e);
    }
    e.values[r.kpi_code] = toNumber(r.value) ?? 0;
  }
  return [...out.values()];
}

/** Largest value of one KPI across entries (bar scale). */
export function maxOf(entries: readonly BreakdownEntry[], code: string): number {
  return entries.reduce((m, e) => Math.max(m, e.values[code] ?? 0), 0);
}

/**
 * The list behind each tile (drill-down). Lists apply their own RLS, so they show
 * the same records the KPI counted, or a superset where the list has no period filter.
 */
export const KPI_LINKS: Partial<Record<KpiCode, string>> = {
  VISITS_PLANNED: "/visits",
  VISITS_COMPLETED: "/visits",
  VISITS_VERIFIED_PCT: "/visits",
  VISIT_AVG_MINUTES: "/visits",
  CUSTOMERS_ADDED: "/customers",
  NEW_ACCOUNTS: "/finance/invoices",
  ORDERS_BOOKED: "/orders",
  BOOKED_SALES: "/orders",
  APPROVAL_TURNAROUND_HOURS: "/orders?status=approved",
  SALES_FULFILLED: "/orders?status=fulfilled",
  NET_REVENUE: "/finance/invoices",
  CASH_COLLECTED: "/finance/aging",
  AR_OPEN: "/finance/aging",
  AR_OVERDUE: "/finance/aging",
  STOCK_ALERTS: "/inventory",
  PENDING_APPROVALS: "/approvals",
};

/** Units as registered in perf.kpi_definitions (for tables that carry no unit column). */
export const KPI_UNIT: Record<KpiCode, KpiUnit> = {
  VISITS_PLANNED: "count",
  VISITS_COMPLETED: "count",
  VISITS_VERIFIED_PCT: "pct",
  VISIT_AVG_MINUTES: "minutes",
  CUSTOMERS_ADDED: "count",
  NEW_ACCOUNTS: "count",
  ORDERS_BOOKED: "count",
  BOOKED_SALES: "egp",
  APPROVAL_TURNAROUND_HOURS: "hours",
  SALES_FULFILLED: "egp",
  NET_REVENUE: "egp",
  CASH_COLLECTED: "egp",
  AR_OPEN: "egp",
  AR_OVERDUE: "egp",
  STOCK_ALERTS: "count",
  PENDING_APPROVALS: "count",
};

/** Tiles per dashboard. The server decides what each user may see; this only lays it out. */
export const TILE_GROUPS: Record<"field" | "sales" | "cash" | "operations", readonly KpiCode[]> = {
  field: ["VISITS_COMPLETED", "VISITS_VERIFIED_PCT", "VISIT_AVG_MINUTES", "CUSTOMERS_ADDED"],
  sales: ["ORDERS_BOOKED", "BOOKED_SALES", "SALES_FULFILLED", "NET_REVENUE", "NEW_ACCOUNTS"],
  cash: ["CASH_COLLECTED", "AR_OPEN", "AR_OVERDUE"],
  operations: ["APPROVAL_TURNAROUND_HOURS", "PENDING_APPROVALS", "STOCK_ALERTS"],
};

/** KPIs a target can be set for (stock alerts and pending approvals are live operational counts). */
export const TARGETABLE_CODES = (Object.keys(KPI_UNIT) as KpiCode[]).filter((c) => c !== "STOCK_ALERTS" && c !== "PENDING_APPROVALS");

/** Columns of the team table (the KPIs requested from api.kpi_team). */
export const TEAM_CODES = [
  "VISITS_PLANNED",
  "VISITS_COMPLETED",
  "VISITS_VERIFIED_PCT",
  "ORDERS_BOOKED",
  "BOOKED_SALES",
  "CASH_COLLECTED",
  "AR_OVERDUE",
] as const satisfies readonly KpiCode[];

export const TERRITORY_CODES = ["VISITS_COMPLETED", "BOOKED_SALES", "NET_REVENUE", "CASH_COLLECTED", "AR_OVERDUE"] as const satisfies readonly KpiCode[];
export const BRAND_CODES = ["BOOKED_SALES", "SALES_FULFILLED", "NET_REVENUE"] as const satisfies readonly KpiCode[];

const SCOPE_RANK: Record<Grant["scope"], number> = { own: 0, team: 1, territory: 2, department: 2, warehouse: 2, all: 3 };

/** own → rep dashboard · team/territory → manager · all (and owners) → company. */
export function dashboardScope(ctx: Pick<UserContext, "is_owner" | "permissions">): DashboardScope | null {
  if (ctx.is_owner) return "all";
  const grant = ctx.permissions["perf.kpi.read"];
  if (!grant) return null;
  const rank = SCOPE_RANK[grant.scope] ?? 0;
  if (rank >= 3) return "all";
  return rank >= 1 ? "team" : "own";
}

/** Query string for a dashboard link that keeps the current period (and employee filter). */
export function periodHref(period: Period, extra: Record<string, string | undefined> = {}): string {
  const params = new URLSearchParams();
  params.set("period", period.kind);
  if (period.kind === "custom") {
    params.set("from", period.from);
    params.set("to", period.to);
  }
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `/dashboard?${params.toString()}`;
}

export const DASHBOARD_ERROR_CODES = ["PERMISSION_DENIED", "VALIDATION", "NOT_FOUND", "INVALID_STATE", "CONFLICT", "UNAVAILABLE", "UNKNOWN"] as const;
export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number];

export function dashboardErrorCode(error: Pick<AppError, "code">): DashboardErrorCode {
  return (DASHBOARD_ERROR_CODES as readonly string[]).includes(error.code) ? (error.code as DashboardErrorCode) : "UNKNOWN";
}
