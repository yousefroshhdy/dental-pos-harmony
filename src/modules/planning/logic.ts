import { can, type UserContext } from "@/lib/authz/can";
import {
  WEEK_DAYS,
  type CoverageRow,
  type PlanningEmployee,
  type PlanRow,
  type Proposal,
  type WeekDay,
} from "./types";

/**
 * Pure planning helpers (unit-tested). Days are "YYYY-MM-DD" strings in Cairo time; arithmetic
 * is done at UTC noon so it is safe across DST changes. Postgres decides every rule again
 * (api.plan_visits / api.unplan_visit); these only shape the screens.
 */

// ---------------------------------------------------------------------------
// Permissions (UX only)
// ---------------------------------------------------------------------------
export const canPlan = (ctx: UserContext) => can(ctx, "field.visit.plan");
/** Managers plan for their team (field.visit.plan at team scope or wider). */
export const canPlanTeam = (ctx: UserContext) => can(ctx, "field.visit.plan", "team");
export const canSeeCoverage = (ctx: UserContext) => can(ctx, "field.visit.read");
/** Visit frequency is a manager setting: crm.customer.update at team scope or wider. */
export const canSetFrequency = (ctx: UserContext) => can(ctx, "crm.customer.update", "team");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Codes with their own text under planning.errors.* (the rest use the shared errors.*). */
export const PLANNING_ERROR_CODES = [
  "PAST_DATE",
  "NOT_ASSIGNED",
  "DUPLICATE",
  "NO_EMPLOYEE_PROFILE",
  "DAILY_CAP",
  "TIMEOUT",
] as const;
export type PlanningErrorCode = (typeof PLANNING_ERROR_CODES)[number];

export function planningErrorCode(code: string | undefined): PlanningErrorCode | null {
  return (PLANNING_ERROR_CODES as readonly string[]).includes(code ?? "") ? (code as PlanningErrorCode) : null;
}

// ---------------------------------------------------------------------------
// Days, weeks, months
// ---------------------------------------------------------------------------
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function parts(day: string): [number, number, number] {
  return day.split("-").map(Number) as [number, number, number];
}

/** A real calendar day "YYYY-MM-DD", or null. Accepts a search-param value (string or array). */
export function parseDay(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !DAY.test(v)) return null;
  const [y, m, d] = parts(v);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? v : null;
}

/** "YYYY-MM" → its first day "YYYY-MM-01", or null. */
export function parseMonth(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !MONTH.test(v)) return null;
  return parseDay(`${v}-01`);
}

/** Today in Africa/Cairo. */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d, 12) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday (same as Postgres extract(dow)). */
export function dayOfWeek(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function weekDayName(day: string): WeekDay {
  return WEEK_DAYS[dayOfWeek(day)]!;
}

/** Weeks start on Sunday (Egypt's working week is Sunday to Thursday). */
export function weekStartOf(day: string): string {
  return addDays(day, -dayOfWeek(day));
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** The days shown in the week grid: the working days, plus any other day that has visits. */
export function visibleDays(weekStart: string, workDays: readonly WeekDay[], rows: readonly PlanRow[]): string[] {
  const busy = new Set(rows.map((r) => r.planned_for));
  return weekDates(weekStart).filter((d) => workDays.includes(weekDayName(d)) || busy.has(d));
}

/** "YYYY-MM" of a day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const date = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
  return date.toISOString().slice(0, 7);
}

/** Default day for "add a visit": the first working day of the week from today on, else today or the week start. */
export function defaultPlanDay(weekStart: string, today: string, workDays: readonly WeekDay[]): string {
  const days = weekDates(weekStart).filter((d) => d >= today);
  return days.find((d) => workDays.includes(weekDayName(d))) ?? (weekStart > today ? weekStart : today);
}

// ---------------------------------------------------------------------------
// Week grid
// ---------------------------------------------------------------------------
/** Planned visits grouped by day, each day sorted by customer name. */
export function groupByDay(rows: readonly PlanRow[], locale: string): Map<string, PlanRow[]> {
  const out = new Map<string, PlanRow[]>();
  for (const r of rows) {
    const list = out.get(r.planned_for) ?? [];
    list.push(r);
    out.set(r.planned_for, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.customer_name ?? "").localeCompare(b.customer_name ?? "", locale));
  return out;
}

/** The employee whose plan is shown: the requested one if the caller may plan for them, else the caller, else the first. */
export function pickEmployee(employees: readonly PlanningEmployee[], requested: unknown): PlanningEmployee | null {
  const want = Array.isArray(requested) ? requested[0] : requested;
  return employees.find((e) => e.id === want) ?? employees.find((e) => e.is_me) ?? employees[0] ?? null;
}

/** Self first, then by name. */
export function sortEmployees(employees: readonly PlanningEmployee[], locale: string): PlanningEmployee[] {
  const name = (e: PlanningEmployee) => (locale === "ar" && e.full_name_ar ? e.full_name_ar : e.full_name_en);
  return [...employees].sort((a, b) => Number(b.is_me) - Number(a.is_me) || name(a).localeCompare(name(b), locale));
}

// ---------------------------------------------------------------------------
// Generated plan review
// ---------------------------------------------------------------------------
/** Checkbox value of one proposal: "customerId|YYYY-MM-DD". */
export function proposalValue(p: Pick<Proposal, "customer_id" | "date">): string {
  return `${p.customer_id}|${p.date}`;
}

export function parseProposalValue(value: string): { customer_id: string; date: string } | null {
  const [customer_id, date, extra] = value.split("|");
  if (!customer_id || !date || extra !== undefined || !parseDay(date)) return null;
  return { customer_id, date };
}

export function groupProposals(proposals: readonly Proposal[]): { date: string; items: Proposal[] }[] {
  const byDay = new Map<string, Proposal[]>();
  for (const p of proposals) byDay.set(p.date, [...(byDay.get(p.date) ?? []), p]);
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, items }));
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------
/** Overdue first (never visited, then most days overdue), then the rest by name. */
export function sortCoverage(rows: readonly CoverageRow[], locale: string): CoverageRow[] {
  const rank = (r: CoverageRow) => (!r.is_overdue ? 2 : r.last_visit_on === null ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.overdue_days ?? 0) - (a.overdue_days ?? 0) ||
      a.customer_name.localeCompare(b.customer_name, locale),
  );
}

export type CoverageFilter = "overdue" | "all";
export function parseCoverageFilter(value: unknown): CoverageFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "all" ? "all" : "overdue";
}

/** Share of the period target reached, 0–100 (capped). */
export function coveragePct(row: Pick<CoverageRow, "actual_visits" | "target_visits">): number {
  if (row.target_visits <= 0) return 100;
  return Math.min(100, Math.round((100 * row.actual_visits) / row.target_visits));
}
