import type { OrderErrorCode } from "./logic";
import type { CatalogSnapshot } from "./offline-logic";

/**
 * Row shapes of the views the orders UI reads:
 *   api.v_orders, api.v_order_lines, api.v_stock_available (…_orders_inventory_workflow.sql)
 *   api.v_sellable_variants, api.v_order_status_history (…20261030000300_orders_ui_views.sql)
 *   api.v_customers (…_crm_field_commands.sql)
 * numeric(14,2) columns may arrive from PostgREST as a number or a string.
 */

export const ORDER_STATUSES = [
  "draft",
  "submitted",
  "pending_approval",
  "approved",
  "rejected",
  "reserved",
  "partially_fulfilled",
  "fulfilled",
  "invoiced",
  "closed",
  "cancelled",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

type Numeric = number | string;

export interface OrderRow {
  id: string;
  order_no: string | null;
  customer_id: string;
  customer_name: string | null;
  employee_id: string;
  employee_name: string | null;
  territory_id: string | null;
  visit_id: string | null;
  status: OrderStatus;
  currency: string;
  payment_terms_days: number;
  subtotal: Numeric;
  discount_total: Numeric;
  tax_total: Numeric;
  total: Numeric;
  notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  pending_approval_request_id: string | null;
}

export interface OrderLineRow {
  order_item_id: string;
  order_id: string;
  line_no: number;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  quantity: number;
  list_price: Numeric;
  applied_discount_pct: Numeric;
  tax_rate_pct: Numeric;
  line_subtotal: Numeric;
  line_discount: Numeric;
  line_tax: Numeric;
  line_total: Numeric;
  fulfilled_qty: number;
  reserved_qty: number;
}

export interface OrderHistoryRow {
  id: number;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_at: string;
  reason: string | null;
  is_mine: boolean | null;
  changed_by_name_en: string | null;
  changed_by_name_ar: string | null;
}

export interface SellableVariant {
  variant_id: string;
  sku: string;
  variant_name: string;
  uom: string;
  product_code: string;
  product_name_en: string;
  product_name_ar: string | null;
  brand_name: string | null;
}

export interface CustomerOption {
  id: string;
  customer_no: string | null;
  display_name: string;
}

export interface StockAvailableRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  variant_id: string;
  available: number;
}

/** A line in the builder: only what the client is allowed to send, plus display text. */
export interface BuilderLine {
  variant_id: string;
  quantity: number;
  sku: string;
  name: string;
}

/** Result of an orders Server Action. Only a translatable code and a request id reach the browser. */
export type OrderActionResult =
  | { ok: true; cancelRequested?: boolean }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };
/** `null` = the form has not been submitted yet (useActionState initial state). */
export type OrderActionState = OrderActionResult | null;

export type CatalogSnapshotResult =
  | { ok: true; snapshot: CatalogSnapshot }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };

export type VariantSearchResult =
  | { ok: true; items: SellableVariant[] }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };
