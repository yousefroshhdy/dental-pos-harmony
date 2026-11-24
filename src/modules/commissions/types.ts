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

// ---------------------------------------------------------------------------
// Rate editor and rep statement (supabase/migrations/20261125000400_commissions_on.sql)
// ---------------------------------------------------------------------------
export const PLAN_STATUSES = ["draft", "active", "retired"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Targets in the engine's specificity order (most specific first). */
export const RATE_TARGETS = ["variant", "category", "brand", "default"] as const;
export type RateTarget = (typeof RATE_TARGETS)[number];

export const RULE_STATES = ["current", "scheduled", "ended", "void"] as const;
export type RuleState = (typeof RULE_STATES)[number];

/** api.v_commission_plans */
export interface PlanRow {
  id: string;
  code: string;
  name: string;
  basis: "collected" | "invoiced";
  status: PlanStatus;
  effective_from: string;
  effective_to: string | null;
  is_default: boolean;
  activated_at: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  created_at: string;
  current_rate_count: number;
  assigned_count: number;
}

/** api.v_commission_plan_rules */
export interface RuleRow {
  id: string;
  plan_id: string;
  plan_code: string;
  target_type: RateTarget;
  target_id: string | null;
  target_code: string | null;
  target_name_en: string | null;
  target_name_ar: string | null;
  rate_pct: DbNumber;
  priority: number;
  effective_from: string | null;
  effective_to: string | null;
  voided_at: string | null;
  note: string | null;
  created_at: string;
  state: RuleState;
}

/** api.commission_unrated(plan, day) */
export interface UnratedRow {
  variant_id: string;
  sku: string;
  variant_name_en: string;
  product_id: string;
  product_code: string;
  product_name_en: string;
  product_name_ar: string | null;
  brand_id: string;
  brand_code: string;
  brand_name: string;
  category_id: string;
  category_code: string;
  category_name_en: string;
  category_name_ar: string;
}

/** api.v_commission_statement_totals */
export interface StatementTotalsRow {
  period_id: string;
  period_start: string;
  period_end: string;
  period_status: PeriodStatus;
  employee_id: string;
  employee_no: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  collected_gross: DbNumber;
  vat_amount: DbNumber;
  commissionable: DbNumber;
  unrated_base: DbNumber;
  commission: DbNumber;
  clawbacks: DbNumber;
  clawback_base: DbNumber;
  adjustments: DbNumber;
  net: DbNumber;
  entry_count: number;
}

/** A rate target the editor can pick (brand, category or product). */
export interface TargetOption {
  id: string;
  label: string;
}

export type CommissionActionMessageKey =
  | "recalculated"
  | "closed"
  | "pending"
  | "posted"
  | "planCreated"
  | "rateSet"
  | "rateCleared"
  | "planActivated"
  | "planDeactivated";

export type CommissionActionResult =
  | { ok: true; message: CommissionActionMessageKey; planId?: string }
  | { ok: false; errorCode: CommissionErrorCode; requestId?: string; mfaRequired?: boolean };
export type CommissionActionState = CommissionActionResult | null;
