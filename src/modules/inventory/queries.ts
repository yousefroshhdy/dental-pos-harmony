import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { addDays, cairoDayStartUtc, type MovementFilters, type StockFilters } from "./logic";
import type {
  AvailableRow,
  MovementRow,
  ReceiptRow,
  ReceiptStatus,
  ReorderAlertRow,
  StockDetailRow,
  StockRow,
  TransferLineRow,
  TransferRow,
  TransferStatus,
  VariantRow,
  WarehouseRow,
} from "./types";

/**
 * Inventory reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS and the warehouse scope decide what comes back.
 * Lists are capped; the ledger pages with a created_at cursor.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "inventory.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "inventory.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const STOCK_LIMIT = 500;
export const MOVEMENT_PAGE = 100;
export const DOC_LIMIT = 100;

const WAREHOUSE_COLUMNS = "id, code, name, kind, is_active, allow_negative, is_sellable";
const VARIANT_COLUMNS =
  "variant_id, sku, variant_name, uom, reorder_point, variant_status, product_id, product_code, product_name, product_name_ar, product_status, is_lot_tracked, is_expiry_tracked, brand_id, brand_code, brand_name";
const STOCK_COLUMNS =
  "warehouse_id, warehouse_code, warehouse_name, warehouse_kind, is_sellable, variant_id, sku, variant_name, product_id, product_name, brand_id, brand_code, brand_name, reorder_point, on_hand, reserved, available, sellable_available, expired_qty, near_expiry_qty, earliest_expiry, days_to_earliest_expiry, lot_count";
const AVAILABLE_COLUMNS = "warehouse_id, warehouse_code, warehouse_name, variant_id, sku, variant_name, product_id, product_name, available";
const ALERT_COLUMNS =
  "variant_id, sku, variant_name, product_id, product_name, brand_id, brand_code, brand_name, reorder_point, sellable_available, shortfall";
const DETAIL_COLUMNS =
  "warehouse_id, warehouse_code, variant_id, sku, lot_id, lot_no, expiry_date, days_to_expiry, on_hand, reserved, available, updated_at";
const MOVEMENT_COLUMNS =
  "id, created_at, movement_type, warehouse_id, warehouse_code, variant_id, sku, lot_id, lot_no, quantity, unit_cost, reason_code, source_doc_type, source_doc_id, reverses_movement_id, approval_request_id, created_by";
const RECEIPT_COLUMNS =
  "id, receipt_no, warehouse_id, warehouse_code, warehouse_name, warehouse_kind, supplier, shipment_ref, status, received_at, created_by, posted_by, posted_at, line_count, total_quantity, items";
const TRANSFER_COLUMNS =
  "id, transfer_no, from_warehouse_id, from_warehouse_code, to_warehouse_id, to_warehouse_code, status, requested_by, created_at, shipped_at, received_at, items";
const TRANSFER_LINE_COLUMNS = "item_id, transfer_id, variant_id, sku, variant_name, lot_id, lot_no, expiry_date, quantity, received_qty";

export async function listWarehouses(): Promise<Result<WarehouseRow[]>> {
  const db = await createClient();
  return run("v_inventory_warehouses", db.from("v_inventory_warehouses").select(WAREHOUSE_COLUMNS).order("code"), []);
}

export async function listVariants(): Promise<Result<VariantRow[]>> {
  const db = await createClient();
  return run("v_inventory_variants", db.from("v_inventory_variants").select(VARIANT_COLUMNS).order("sku").limit(2000), []);
}

export async function getVariant(variantId: string): Promise<Result<VariantRow | null>> {
  const db = await createClient();
  return run("v_inventory_variants", db.from("v_inventory_variants").select(VARIANT_COLUMNS).eq("variant_id", variantId).maybeSingle(), null);
}

/** Inventory roles: stock per warehouse × variant (lot aggregates, expiry, sellability). */
export async function listStock(filter: Omit<StockFilters, "alert">): Promise<Result<StockRow[]>> {
  const db = await createClient();
  let q = db.from("v_inventory_stock").select(STOCK_COLUMNS);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.brand) q = q.eq("brand_id", filter.brand);
  if (filter.product) q = q.eq("product_id", filter.product);
  return run("v_inventory_stock", q.order("sku").order("warehouse_code").limit(STOCK_LIMIT), []);
}

/** Everyone with inventory.stock.read: sellable availability only. */
export async function listAvailable(filter: { warehouse?: string; variantIds?: string[] }): Promise<Result<AvailableRow[]>> {
  const db = await createClient();
  let q = db.from("v_stock_available").select(AVAILABLE_COLUMNS);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.variantIds) q = q.in("variant_id", filter.variantIds);
  return run("v_stock_available", q.order("sku").order("warehouse_code").limit(STOCK_LIMIT), []);
}

export async function listReorderAlerts(filter: { brand?: string; product?: string }): Promise<Result<ReorderAlertRow[]>> {
  const db = await createClient();
  let q = db.from("v_reorder_alerts").select(ALERT_COLUMNS);
  if (filter.brand) q = q.eq("brand_id", filter.brand);
  if (filter.product) q = q.eq("product_id", filter.product);
  return run("v_reorder_alerts", q.order("shortfall", { ascending: false }).order("sku").limit(STOCK_LIMIT), []);
}

export async function listStockDetail(filter: { variant?: string; warehouse?: string; onlyAvailable?: boolean }): Promise<Result<StockDetailRow[]>> {
  const db = await createClient();
  let q = db.from("v_stock_detail").select(DETAIL_COLUMNS);
  if (filter.variant) q = q.eq("variant_id", filter.variant);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.onlyAvailable) q = q.gt("available", 0);
  return run("v_stock_detail", q.order("sku").order("expiry_date", { ascending: true, nullsFirst: false }).limit(STOCK_LIMIT), []);
}

export async function listMovements(filter: MovementFilters): Promise<Result<MovementRow[]>> {
  const db = await createClient();
  let q = db.from("v_movements").select(MOVEMENT_COLUMNS);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.variant) q = q.eq("variant_id", filter.variant);
  if (filter.type) q = q.eq("movement_type", filter.type);
  if (filter.sourceType) q = q.eq("source_doc_type", filter.sourceType);
  if (filter.sourceId) q = q.eq("source_doc_id", filter.sourceId);
  if (filter.from) q = q.gte("created_at", cairoDayStartUtc(filter.from));
  if (filter.to) q = q.lt("created_at", cairoDayStartUtc(addDays(filter.to, 1)));
  // Keyset paging on (created_at desc, id asc): one transaction stamps all its movements with the same time.
  // Both values are validated in parseMovementFilters and quoted for PostgREST's or() syntax.
  if (filter.before && filter.beforeId) {
    q = q.or(`created_at.lt."${filter.before}",and(created_at.eq."${filter.before}",id.gt.${filter.beforeId})`);
  }
  return run("v_movements", q.order("created_at", { ascending: false }).order("id").limit(MOVEMENT_PAGE), []);
}

export async function listReceipts(filter: { status?: ReceiptStatus; warehouse?: string }): Promise<Result<ReceiptRow[]>> {
  const db = await createClient();
  let q = db.from("v_goods_receipts").select(RECEIPT_COLUMNS);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  return run("v_goods_receipts", q.order("received_at", { ascending: false }).limit(DOC_LIMIT), []);
}

export async function getReceipt(receiptId: string): Promise<Result<ReceiptRow | null>> {
  const db = await createClient();
  return run("v_goods_receipts", db.from("v_goods_receipts").select(RECEIPT_COLUMNS).eq("id", receiptId).maybeSingle(), null);
}

export async function listTransfers(filter: { status?: TransferStatus; warehouse?: string }): Promise<Result<TransferRow[]>> {
  const db = await createClient();
  let q = db.from("v_transfers").select(TRANSFER_COLUMNS);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.warehouse) q = q.or(`from_warehouse_id.eq.${filter.warehouse},to_warehouse_id.eq.${filter.warehouse}`);
  return run("v_transfers", q.order("created_at", { ascending: false }).limit(DOC_LIMIT), []);
}

export async function listTransferLines(transferIds: string[]): Promise<Result<TransferLineRow[]>> {
  if (transferIds.length === 0) return ok([]);
  const db = await createClient();
  return run("v_transfer_lines", db.from("v_transfer_lines").select(TRANSFER_LINE_COLUMNS).in("transfer_id", transferIds).order("sku"), []);
}
