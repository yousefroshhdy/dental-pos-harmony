import type { ReturnErrorCode } from "./logic";

/** numeric columns arrive from PostgREST as number or string. */
export type Numeric = number | string;

/** sales.returns.status (CHECK in 20261028000700_sales.sql). */
export const RETURN_STATUSES = ["requested", "pending_approval", "approved", "received", "credited", "rejected"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** sales.return_items.reason_code (CHECK in 20261103000200_returns.sql). */
export const REASON_CODES = [
  "damaged",
  "defective",
  "wrong_item",
  "expired",
  "near_expiry",
  "not_ordered",
  "customer_request",
  "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** sales.return_items.condition. */
export const CONDITIONS = ["resaleable", "damaged", "expired"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** api.v_returns */
export interface ReturnRow {
  id: string;
  return_no: string;
  order_id: string;
  order_no: string | null;
  order_status: string | null;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  rep_employee_id: string | null;
  rep_name_en: string | null;
  rep_name_ar: string | null;
  territory_id: string | null;
  status: ReturnStatus;
  reason: string;
  notes: string | null;
  warehouse_id: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  approval_request_id: string | null;
  approval_status: string | null;
  created_by: string | null;
  requested_by_name_en: string | null;
  requested_by_name_ar: string | null;
  is_mine: boolean;
  created_at: string;
  decided_at: string | null;
  received_at: string | null;
  credited_at: string | null;
  updated_at: string;
  lines: number;
  total_qty: number;
  credited_qty: number;
  estimated_total: Numeric;
  credit_notes: number;
  credited_total: Numeric;
}

/** api.v_return_lines */
export interface ReturnLineRow {
  return_item_id: string;
  return_id: string;
  order_item_id: string;
  line_no: number;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  lot_id: string;
  lot_no: string | null;
  expiry_date: string | null;
  quantity: number;
  credited_qty: number;
  reason_code: ReasonCode | null;
  condition: Condition;
  list_price: Numeric;
  applied_discount_pct: Numeric;
  tax_rate_pct: Numeric;
  estimated_total: Numeric;
}

/** api.v_returnable_lines (one row per order line and delivered lot). */
export interface ReturnableLineRow {
  order_id: string;
  order_item_id: string;
  line_no: number;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  lot_id: string;
  lot_no: string | null;
  expiry_date: string | null;
  delivered_qty: number;
  returned_qty: number;
  invoiced_qty: number;
  credited_other_qty: number;
  line_returned_qty: number;
  returnable_qty: number;
}

/** The order a return is requested from (api.v_orders subset). */
export interface ReturnOrderRow {
  id: string;
  order_no: string | null;
  customer_id: string;
  customer_name: string | null;
  status: string;
  total: Numeric;
  submitted_at: string | null;
  created_at: string;
}

/** api.v_inventory_warehouses subset. */
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

/** api.v_credit_notes subset (credit notes linked to a return). */
export interface ReturnCreditNoteRow {
  id: string;
  credit_no: string;
  invoice_id: string;
  invoice_no: string | null;
  amount: Numeric;
  tax_amount: Numeric;
  total: Numeric;
  issue_date: string;
}

export type ReturnActionResult =
  | { ok: true; message?: "requested" | "received" | "credited" }
  | { ok: false; errorCode: ReturnErrorCode; requestId?: string };
export type ReturnActionState = ReturnActionResult | null;
