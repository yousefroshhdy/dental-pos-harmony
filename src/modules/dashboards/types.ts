/**
 * Dashboard read shapes. Every number is computed by registered metric functions in
 * Postgres (perf.metric_*, ADR-015) and scoped there by perf.kpi.read; the UI only
 * formats and lays them out.
 */

/** KPI codes the dashboards render (active definitions in perf.kpi_definitions). */
export const KPI_CODES = [
  "VISITS_PLANNED",
  "VISITS_COMPLETED",
  "VISITS_VERIFIED_PCT",
  "VISIT_AVG_MINUTES",
  "CUSTOMERS_ADDED",
  "NEW_ACCOUNTS",
  "ORDERS_BOOKED",
  "BOOKED_SALES",
  "APPROVAL_TURNAROUND_HOURS",
  "SALES_FULFILLED",
  "NET_REVENUE",
  "CASH_COLLECTED",
  "AR_OPEN",
  "AR_OVERDUE",
  "STOCK_ALERTS",
  "PENDING_APPROVALS",
] as const;
export type KpiCode = (typeof KPI_CODES)[number];

export const KPI_UNITS = ["count", "pct", "egp", "ratio", "minutes", "hours"] as const;
export type KpiUnit = (typeof KPI_UNITS)[number];

/** PostgREST returns numeric as a JSON number, or as a string when very large. */
export type DbNumber = number | string | null;

export interface KpiRow {
  kpi_code: string;
  unit: KpiUnit;
  higher_is_better: boolean;
  is_point_in_time: boolean;
  value: DbNumber;
  target: DbNumber;
  achievement_pct: DbNumber;
  detail: Record<string, unknown> | null;
}

export interface TeamRow {
  employee_id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  kpi_code: string;
  value: DbNumber;
  target: DbNumber;
  achievement_pct: DbNumber;
}

export interface BreakdownRow {
  dimension_id: string;
  dimension_code: string;
  name_en: string;
  name_ar: string | null;
  kpi_code: string;
  value: DbNumber;
}

export interface OverdueCustomerRow {
  customer_id: string;
  customer_no: string;
  display_name: string;
  employee_id: string | null;
  overdue_amount: DbNumber;
  invoice_count: number;
  oldest_due_date: string;
  days_overdue: number;
}

export interface PendingApprovalRow {
  request_id: string;
  workflow_code: string;
  workflow_name: string;
  created_at: string;
  subject_name_en: string | null;
  subject_name_ar: string | null;
  customer_name: string | null;
}

export interface KpiTargetRow {
  id: string;
  kpi_code: string;
  unit: KpiUnit;
  employee_id: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  role_id: string | null;
  role_code: string | null;
  role_name_en: string | null;
  role_name_ar: string | null;
  territory_id: string | null;
  territory_code: string | null;
  territory_name_en: string | null;
  territory_name_ar: string | null;
  target_value: DbNumber;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface Option {
  id: string;
  label_en: string;
  label_ar: string | null;
}

export const PERIOD_KINDS = ["today", "week", "month", "custom"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** A Cairo-calendar period; dates are ISO `YYYY-MM-DD`, both inclusive. */
export interface Period {
  kind: PeriodKind;
  from: string;
  to: string;
}

/** Which dashboard a user gets, from the scope of their perf.kpi.read grant. */
export type DashboardScope = "own" | "team" | "all";

export type KpiStatus = "onTrack" | "atRisk" | "behind";

export type TargetActionState = { ok: true } | { ok: false; errorCode: string; requestId?: string } | null;
