import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { cleanSearch, ilikeAny, type Page, type PageRequest } from "@/modules/orders/kit/paging";
import { runPage } from "@/modules/orders/kit/run-page";
import { AVAILABLE_LIST, MOVEMENT_LIST, RECEIPT_LIST, STOCK_LIST } from "./lists";
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

// ---------------------------------------------------------------------------
// Server-paginated lists (Phase P): one window plus the total that matches.
// ---------------------------------------------------------------------------

const windowOf = (page: PageRequest) => [page.offset, page.offset + page.limit - 1] as const;

/**
 * Inventory roles: one page of stock rows. The alert filter runs in the database
 * (near expiry, expired, not sellable from the row; below reorder = a sellable row
 * of a variant in `belowReorderIds`, the v_reorder_alerts answer).
 */
export async function listStockPage(filter: StockFilters, belowReorderIds: readonly string[], page: PageRequest): Promise<Result<Page<StockRow>>> {
  const db = await createClient();
  let q = db.from("v_inventory_stock").select(STOCK_COLUMNS, { count: "exact" });
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.brand) q = q.eq("brand_id", filter.brand);
  if (filter.product) q = q.eq("product_id", filter.product);
  switch (filter.alert) {
    case "near_expiry":
      q = q.gt("near_expiry_qty", 0);
      break;
    case "expired":
      q = q.gt("expired_qty", 0);
      break;
    case "not_sellable":
      q = q.eq("is_sellable", false);
      break;
    case "below_reorder":
      if (belowReorderIds.length === 0) return ok({ rows: [], total: 0 });
      q = q.eq("is_sellable", true).in("variant_id", [...belowReorderIds]);
      break;
    default:
      break;
  }
  const search = ilikeAny(STOCK_LIST.searchColumns ?? [], page.search);
  if (search) q = q.or(search);
  const [from, to] = windowOf(page);
  const ordered = q
    .order(page.sort.column, { ascending: page.sort.ascending, nullsFirst: false })
    .order("product_name")
    .order("sku")
    .order("is_sellable", { ascending: false })
    .order("warehouse_code");
  return runPage("inventory", "v_inventory_stock", ordered.range(from, to));
}

/** Everyone with inventory.stock.read: one page of sellable availability. */
export async function listAvailablePage(filter: { warehouse?: string; variantIds?: string[] }, page: PageRequest): Promise<Result<Page<AvailableRow>>> {
  if (filter.variantIds && filter.variantIds.length === 0) return ok({ rows: [], total: 0 });
  const db = await createClient();
  let q = db.from("v_stock_available").select(AVAILABLE_COLUMNS, { count: "exact" });
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.variantIds) q = q.in("variant_id", filter.variantIds);
  const search = ilikeAny(AVAILABLE_LIST.searchColumns ?? [], page.search);
  if (search) q = q.or(search);
  const [from, to] = windowOf(page);
  const ordered = q.order(page.sort.column, { ascending: page.sort.ascending, nullsFirst: false }).order("sku").order("warehouse_code");
  return runPage("inventory", "v_stock_available", ordered.range(from, to));
}

/** One page of the stock ledger (newest first by default; the ledger itself is append-only). */
export async function listMovementsPage(filter: MovementFilters, page: PageRequest): Promise<Result<Page<MovementRow>>> {
  const db = await createClient();
  let q = db.from("v_movements").select(MOVEMENT_COLUMNS, { count: "exact" });
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  if (filter.variant) q = q.eq("variant_id", filter.variant);
  if (filter.type) q = q.eq("movement_type", filter.type);
  if (filter.sourceType) q = q.eq("source_doc_type", filter.sourceType);
  if (filter.sourceId) q = q.eq("source_doc_id", filter.sourceId);
  if (filter.from) q = q.gte("created_at", cairoDayStartUtc(filter.from));
  if (filter.to) q = q.lt("created_at", cairoDayStartUtc(addDays(filter.to, 1)));
  const search = ilikeAny(MOVEMENT_LIST.searchColumns ?? [], page.search);
  if (search) q = q.or(search);
  const [from, to] = windowOf(page);
  // One transaction stamps all its movements with the same time: id keeps the order stable.
  const ordered = q.order(page.sort.column, { ascending: page.sort.ascending, nullsFirst: false }).order("created_at", { ascending: false }).order("id");
  return runPage("inventory", "v_movements", ordered.range(from, to));
}

export async function listReceiptsPage(filter: { status?: ReceiptStatus; warehouse?: string }, page: PageRequest): Promise<Result<Page<ReceiptRow>>> {
  const db = await createClient();
  let q = db.from("v_goods_receipts").select(RECEIPT_COLUMNS, { count: "exact" });
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.warehouse) q = q.eq("warehouse_id", filter.warehouse);
  const search = ilikeAny(RECEIPT_LIST.searchColumns ?? [], page.search);
  if (search) q = q.or(search);
  const [from, to] = windowOf(page);
  const ordered = q.order(page.sort.column, { ascending: page.sort.ascending, nullsFirst: false }).order("received_at", { ascending: false }).order("id");
  return runPage("inventory", "v_goods_receipts", ordered.range(from, to));
}

/** How many transfers are in transit (for the banner), with the same warehouse filter as the list. */
export async function countInTransit(warehouse?: string): Promise<Result<number>> {
  const db = await createClient();
  let q = db.from("v_transfers").select("id", { count: "exact", head: true }).eq("status", "in_transit");
  if (warehouse) q = q.or(`from_warehouse_id.eq.${warehouse},to_warehouse_id.eq.${warehouse}`);
  const page = await runPage<never>("inventory", "v_transfers", q);
  return page.ok ? ok(page.data.total) : page;
}

export async function listTransfersPage(filter: { status?: TransferStatus; warehouse?: string }, page: PageRequest): Promise<Result<Page<TransferRow>>> {
  const db = await createClient();
  let q = db.from("v_transfers").select(TRANSFER_COLUMNS, { count: "exact" });
  if (filter.status) q = q.eq("status", filter.status);
  // The warehouse id is validated as a uuid in parseStockFilters before it reaches or().
  if (filter.warehouse) q = q.or(`from_warehouse_id.eq.${filter.warehouse},to_warehouse_id.eq.${filter.warehouse}`);
  // One searched column, so a plain ilike (the warehouse filter above already uses or()).
  const search = cleanSearch(page.search);
  if (search) q = q.ilike("transfer_no", `*${search}*`);
  const [from, to] = windowOf(page);
  const ordered = q.order(page.sort.column, { ascending: page.sort.ascending, nullsFirst: false }).order("created_at", { ascending: false }).order("id");
  return runPage("inventory", "v_transfers", ordered.range(from, to));
}
