import type { CommissionErrorCode } from "./logic";

/**
 * Shapes of the commission reads (supabase/migrations/20261103000400_commissions.sql).
 * PostgREST returns numeric columns as numbers or strings; DbNumber covers both.
 */
export type DbNumber = number | string;

export const PERIOD_STATUSES = ["open", "calculated", "approved", "paid", "locked"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/** Rows the engine writes (entries) and the kinds of approved adjustments. */
export const ENTRY_KINDS = ["collection", "reversal", "bounce", "credit_clawback", "credit_reattribution"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const ADJUSTMENT_KINDS = ["bonus", "clawback", "correction"] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];
export type LineKind = EntryKind | AdjustmentKind;

export const REQUEST_STATUSES = ["pending", "approved", "rejected", "cancelled", "expired"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** api.v_commission_statement */
export interface StatementLine {
  line_type: "entry" | "adjustment";
  id: string;
  period_start: string;
  period_status: PeriodStatus;
  employee_id: string;
  kind: LineKind;
  source_type: "payment_allocation" | "allocation_reversal" | "credit_note" | null;
  invoice_id: string | null;
  invoice_no: string | null;
  order_no: string | null;
  customer_name: string | null;
  sku: string | null;
  description: string | null;
  document_no: string | null;
  base_amount: DbNumber | null;
  rate_pct: DbNumber | null;
  amount: DbNumber;
  event_at: string;
  event_date: string;
  reason: string | null;
}

/** api.v_commission_summary */
export interface SummaryRow {
  period_id: string;
  period_start: string;
  period_status: PeriodStatus;
  employee_id: string;
  employee_no: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  earned: DbNumber;
  clawed_back: DbNumber;
  adjustments: DbNumber;
  total: DbNumber;
  base_total: DbNumber;
  entry_count: number;
}

/** api.v_commission_periods */
export interface PeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  status: PeriodStatus;
  is_frozen: boolean;
  closes_at: string;
  calculated_at: string | null;
  closed_at: string | null;
  entries_total: DbNumber;
  entry_count: number;
  adjustments_total: DbNumber;
  total: DbNumber;
  employee_count: number;
}

/** api.v_commission_adjustment_requests */
export interface AdjustmentRequestRow {
  request_id: string;
  adjustment_id: string;
  status: RequestStatus;
  created_at: string;
  decided_at: string | null;
  is_mine: boolean;
  employee_id: string | null;
  employee_no: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  period_start: string;
  amount: DbNumber;
  kind: AdjustmentKind;
  reason: string;
}

export interface EmployeeOption {
  id: string;
  label: string;
}

export type CommissionActionResult =
  | { ok: true; message: "recalculated" | "closed" | "pending" | "posted" }
  | { ok: false; errorCode: CommissionErrorCode; requestId?: string };
export type CommissionActionState = CommissionActionResult | null;
