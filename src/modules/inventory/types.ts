/**
 * Row shapes of the api.v_* views the inventory workspace reads.
 * Sources: supabase/migrations/20261029000300_orders_inventory_workflow.sql (§7)
 * and 20261030000400_inventory_ui_views.sql. Dates arrive as `YYYY-MM-DD`,
 * timestamps as ISO strings.
 */

export const WAREHOUSE_KINDS = ["main", "branch", "rep_stock", "quarantine", "transit"] as const;
export type WarehouseKind = (typeof WAREHOUSE_KINDS)[number];

export const MOVEMENT_TYPES = [
  "receipt",
  "sale_issue",
  "sale_return",
  "transfer_out",
  "transfer_in",
  "adjustment_in",
  "adjustment_out",
  "damage",
  "expiry_writeoff",
  "reversal",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const RECEIPT_STATUSES = ["draft", "posted", "cancelled"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const TRANSFER_STATUSES = ["draft", "pending_approval", "approved", "in_transit", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** api.v_inventory_warehouses */
export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  kind: WarehouseKind;
  is_active: boolean;
  allow_negative: boolean;
  is_sellable: boolean;
}

/** api.v_inventory_variants */
export interface VariantRow {
  variant_id: string;
  sku: string;
  variant_name: string;
  uom: string;
  reorder_point: number;
  variant_status: string;
  product_id: string;
  product_code: string;
  product_name: string;
  product_name_ar: string | null;
  product_status: string;
  is_lot_tracked: boolean;
  is_expiry_tracked: boolean;
  brand_id: string;
  brand_code: string;
  brand_name: string;
}

/** api.v_inventory_stock (inventory roles) */
export interface StockRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  warehouse_kind: WarehouseKind;
  is_sellable: boolean;
  variant_id: string;
  sku: string;
  variant_name: string;
  product_id: string;
  product_name: string;
  brand_id: string;
  brand_code: string;
  brand_name: string;
  reorder_point: number;
  on_hand: number;
  reserved: number;
  available: number;
  sellable_available: number;
  expired_qty: number;
  near_expiry_qty: number;
  earliest_expiry: string | null;
  days_to_earliest_expiry: number | null;
  lot_count: number;
}

/** api.v_stock_available (sellable availability; safe for reps) */
export interface AvailableRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  variant_id: string;
  sku: string;
  variant_name: string;
  product_id: string;
  product_name: string;
  available: number;
}

/** api.v_reorder_alerts */
export interface ReorderAlertRow {
  variant_id: string;
  sku: string;
  variant_name: string;
  product_id: string;
  product_name: string;
  brand_id: string;
  brand_code: string;
  brand_name: string;
  reorder_point: number;
  sellable_available: number;
  shortfall: number;
}

/** api.v_stock_detail (lot level, inventory roles) */
export interface StockDetailRow {
  warehouse_id: string;
  warehouse_code: string;
  variant_id: string;
  sku: string;
  lot_id: string;
  lot_no: string;
  expiry_date: string | null;
  days_to_expiry: number | null;
  on_hand: number;
  reserved: number;
  available: number;
  updated_at: string;
}

/** api.v_movements (unit_cost masked unless catalog.cost.read) */
export interface MovementRow {
  id: string;
  created_at: string;
  movement_type: MovementType;
  warehouse_id: string;
  warehouse_code: string | null;
  variant_id: string;
  sku: string | null;
  lot_id: string;
  lot_no: string | null;
  quantity: number;
  unit_cost: number | string | null;
  reason_code: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
  reverses_movement_id: string | null;
  approval_request_id: string | null;
  created_by: string | null;
}

export interface ReceiptItem {
  item_id: string;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  lot_no: string;
  expiry_date: string | null;
  quantity: number;
  unit_cost: number | string | null;
}

/** api.v_goods_receipts */
export interface ReceiptRow {
  id: string;
  receipt_no: string;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  warehouse_kind: WarehouseKind | null;
  supplier: string;
  shipment_ref: string | null;
  status: ReceiptStatus;
  received_at: string;
  created_by: string | null;
  posted_by: string | null;
  posted_at: string | null;
  line_count: number;
  total_quantity: number;
  items: ReceiptItem[];
}

/** api.v_transfers */
export interface TransferRow {
  id: string;
  transfer_no: string;
  from_warehouse_id: string;
  from_warehouse_code: string | null;
  to_warehouse_id: string;
  to_warehouse_code: string | null;
  status: TransferStatus;
  requested_by: string | null;
  created_at: string;
  shipped_at: string | null;
  received_at: string | null;
  items: { variant_id: string; lot_id: string; quantity: number; received_qty: number }[];
}

/** api.v_transfer_lines */
export interface TransferLineRow {
  item_id: string;
  transfer_id: string;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  lot_id: string;
  lot_no: string | null;
  expiry_date: string | null;
  quantity: number;
  received_qty: number;
}

/** A failed inventory Server Action: the business code (for inventory.errors.*) plus the generic errors.* key. */
export interface ActionFailure {
  ok: false;
  /** Business code from the database (e.g. INSUFFICIENT_STOCK) or a form check. */
  code: string;
  /** Fallback key under errors.* */
  messageKey: string;
  requestId?: string;
}

export type ActionResult = { ok: true } | ActionFailure;
export type ActionState = ActionResult | null;

export type AdjustmentOutcome = "posted" | "pending_approval" | "approved" | "rejected" | "cancelled";

export type AdjustmentState =
  | null
  | ({
      ok: true;
      outcome: AdjustmentOutcome;
      movementId: string | null;
      approvalRequestId: string | null;
      replayed: boolean;
      /** Fresh key for the next adjustment. */
      nextKey: string;
    })
  | (ActionFailure & {
      /** The key to keep: a deliberate retry of the same adjustment replays instead of posting twice. */
      idempotencyKey: string;
    });
