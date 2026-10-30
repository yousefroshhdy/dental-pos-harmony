import type { FinanceErrorCode } from "./logic";

/**
 * Row shapes of the views the finance UI reads (supabase/migrations/
 * 20261031000110_finance_ar_views.sql). numeric columns may arrive from
 * PostgREST as a number or a string; use toNumber() before arithmetic.
 */
export type Numeric = number | string;

export const INVOICE_STATUSES = ["issued", "partially_paid", "paid", "credited", "written_off"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_STATUSES = ["pending_verification", "confirmed", "bounced", "reversed"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Every method the table allows (paymob_* arrive from the integration, never by hand). */
export const PAYMENT_METHODS = ["cash", "cheque", "bank_transfer", "instapay", "paymob_card", "paymob_wallet", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Methods a person may record (api.record_payment). */
export const RECORDABLE_METHODS = ["cash", "cheque", "bank_transfer", "instapay", "other"] as const satisfies readonly PaymentMethod[];
export type RecordableMethod = (typeof RECORDABLE_METHODS)[number];

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const COLLECTION_STATUSES = ["open", "promised", "escalated", "collected", "closed"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
export const COLLECTION_ACTIONS = ["promise", "reopen", "escalate", "collected", "close"] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];

export const LEDGER_ENTRY_TYPES = [
  "invoice",
  "credit_note",
  "payment",
  "payment_reversal",
  "write_off",
  "opening_balance",
  "adjustment",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface InvoiceRow {
  id: string;
  invoice_no: string;
  order_id: string | null;
  order_no: string | null;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  territory_id: string | null;
  rep_employee_id: string | null;
  rep_name_en: string | null;
  rep_name_ar: string | null;
  issue_date: string;
  due_date: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: Numeric;
  discount_total: Numeric;
  tax_total: Numeric;
  total: Numeric;
  allocated: Numeric;
  credited: Numeric;
  open_amount: Numeric;
  days_overdue: number;
  is_overdue: boolean;
  aging_bucket: AgingBucket | null;
  eta_status: string | null;
  eta_uuid: string | null;
  created_at: string;
  /** Approved write-offs (20261103000500); already subtracted from open_amount. */
  written_off: Numeric;
}

/** api.v_invoice_write_offs */
export interface WriteOffRow {
  id: string;
  write_off_no: string;
  invoice_id: string;
  invoice_no: string | null;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  amount: Numeric;
  reason: string;
  approval_request_id: string;
  requested_by: string | null;
  requested_by_name_en: string | null;
  requested_by_name_ar: string | null;
  posted_by: string | null;
  posted_by_name_en: string | null;
  posted_by_name_ar: string | null;
  posted_at: string;
}

/** api.v_invoice_print_party: the customer block of a printed invoice. */
export interface PrintPartyRow {
  invoice_id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  clinic_name: string | null;
  doctor_name: string | null;
  address_line: string | null;
  city: string | null;
  governorate_code: string | null;
  governorate_name_en: string | null;
  governorate_name_ar: string | null;
  phone_primary: string | null;
  tax_registration_no: string | null;
  commercial_reg_no: string | null;
}

export interface InvoiceLineRow {
  invoice_item_id: string;
  invoice_id: string;
  order_item_id: string | null;
  variant_id: string;
  sku: string | null;
  description: string;
  quantity: number;
  unit_price: Numeric;
  line_subtotal: Numeric;
  discount: Numeric;
  tax_rate_pct: Numeric;
  tax_amount: Numeric;
  line_total: Numeric;
  credited_qty: number;
  credited_amount: Numeric;
}

export interface CreditNoteRow {
  id: string;
  credit_no: string;
  invoice_id: string;
  invoice_no: string | null;
  customer_id: string;
  customer_name: string | null;
  reason: string;
  amount: Numeric;
  tax_amount: Numeric;
  total: Numeric;
  issue_date: string;
  return_id: string | null;
  approval_request_id: string | null;
  created_at: string;
  by_lines: boolean;
}

export interface PaymentRow {
  id: string;
  payment_no: string;
  client_ref: string | null;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  collected_by: string | null;
  collected_by_name_en: string | null;
  collected_by_name_ar: string | null;
  method: PaymentMethod;
  amount: Numeric;
  allocated: Numeric;
  unallocated: Numeric;
  received_at: string;
  reference: string | null;
  cheque_due_date: string | null;
  status: PaymentStatus;
  status_reason: string | null;
  confirmed_at: string | null;
  reversed_at: string | null;
  created_at: string;
  is_mine: boolean | null;
}

export interface AllocationRow {
  id: string;
  payment_id: string;
  payment_no: string | null;
  payment_method: PaymentMethod | null;
  invoice_id: string;
  invoice_no: string | null;
  amount: Numeric;
  reverses_allocation_id: string | null;
  is_reversed: boolean;
  allocated_at: string;
  reason: string | null;
}

export interface StatementRow {
  entry_id: number;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  posted_at: string;
  posted_date: string;
  entry_type: LedgerEntryType;
  source_table: string;
  source_id: string;
  document_no: string | null;
  due_date: string | null;
  debit: Numeric;
  credit: Numeric;
  amount: Numeric;
  running_balance: Numeric;
}

export interface AgingRow {
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  territory_id: string | null;
  territory_code: string | null;
  territory_name_en: string | null;
  territory_name_ar: string | null;
  rep_employee_id: string | null;
  rep_name_en: string | null;
  rep_name_ar: string | null;
  current_amount: Numeric;
  d1_30: Numeric;
  d31_60: Numeric;
  d61_90: Numeric;
  d90_plus: Numeric;
  total_open: Numeric;
  overdue_amount: Numeric;
  open_invoices: number;
  overdue_invoices: number;
  max_days_overdue: number;
  ledger_balance: Numeric;
  unapplied_credit: Numeric;
}

export interface AgingTotalsRow {
  customers: number;
  current_amount: Numeric;
  d1_30: Numeric;
  d31_60: Numeric;
  d61_90: Numeric;
  d90_plus: Numeric;
  total_open: Numeric;
  overdue_amount: Numeric;
  ledger_balance: Numeric;
  unapplied_credit: Numeric;
}

export interface CollectionTaskRow {
  id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  invoice_id: string | null;
  invoice_no: string | null;
  invoice_due_date: string | null;
  invoice_open_amount: Numeric | null;
  days_overdue: number | null;
  assignee_employee_id: string;
  assignee_name_en: string | null;
  assignee_name_ar: string | null;
  due_date: string;
  status: CollectionStatus;
  promised_amount: Numeric | null;
  promised_date: string | null;
  promise_broken: boolean;
  outcome: string | null;
  work_task_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  is_mine: boolean | null;
}

export interface InvoiceableOrderRow {
  order_id: string;
  order_no: string | null;
  customer_id: string;
  customer_name: string | null;
  status: "fulfilled" | "partially_fulfilled";
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  payment_terms_days: number;
  order_total: Numeric;
  submitted_at: string | null;
  uninvoiced_qty: number;
  uninvoiced_lines: number;
  invoices: number;
}

export interface InvoiceableLineRow {
  order_item_id: string;
  order_id: string;
  line_no: number;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  quantity: number;
  fulfilled_qty: number;
  invoiced_qty: number;
  uninvoiced_qty: number;
  list_price: Numeric;
  applied_discount_pct: Numeric;
  tax_rate_pct: Numeric;
}

export interface CustomerOption {
  id: string;
  customer_no: string;
  display_name: string;
}

/** Pending credit-note requests on an invoice (api.v_approval_requests, workflow finance.credit_note). */
export interface CreditRequestRow {
  request_id: string;
  status: string;
  created_at: string;
  payload: Record<string, unknown> | null;
}

/** Server Action outcome; `null` before the first submit. */
export type FinanceActionResult =
  | { ok: true; message?: "issued" | "pending" | "confirmed" | "recorded" | "done"; href?: string }
  | { ok: false; errorCode: FinanceErrorCode; requestId?: string };
export type FinanceActionState = FinanceActionResult | null;
