import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { sanitizeSearch, toNumber } from "./logic";
import type { CachedVariant } from "./offline-logic";
import type { CustomerOption, OrderHistoryRow, OrderLineRow, OrderRow, OrderStatus, SellableVariant, StockAvailableRow } from "./types";

/**
 * Orders reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides what comes back: reps their own orders,
 * managers their scope.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "orders.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "orders.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const ORDER_COLUMNS =
  "id, order_no, customer_id, customer_name, employee_id, employee_name, territory_id, visit_id, status, currency, " +
  "payment_terms_days, subtotal, discount_total, tax_total, total, notes, submitted_at, approved_at, version, " +
  "created_at, updated_at, pending_approval_request_id";
const LINE_COLUMNS =
  "order_item_id, order_id, line_no, variant_id, sku, variant_name, quantity, list_price, applied_discount_pct, " +
  "tax_rate_pct, line_subtotal, line_discount, line_tax, line_total, fulfilled_qty, reserved_qty";
const VARIANT_COLUMNS = "variant_id, sku, variant_name, uom, product_code, product_name_en, product_name_ar, brand_name";

export const ORDER_LIST_LIMIT = 200;

export async function listOrders(statuses: readonly OrderStatus[]): Promise<Result<OrderRow[]>> {
  const db = await createClient();
  let query = db.from("v_orders").select(ORDER_COLUMNS);
  if (statuses.length > 0) query = query.in("status", [...statuses]);
  return run("v_orders", query.order("created_at", { ascending: false }).limit(ORDER_LIST_LIMIT), []);
}

export async function getOrder(orderId: string): Promise<Result<OrderRow | null>> {
  const db = await createClient();
  return run("v_orders", db.from("v_orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle(), null);
}

export async function listOrderLines(orderId: string): Promise<Result<OrderLineRow[]>> {
  const db = await createClient();
  return run("v_order_lines", db.from("v_order_lines").select(LINE_COLUMNS).eq("order_id", orderId).order("line_no"), []);
}

export async function listOrderHistory(orderId: string): Promise<Result<OrderHistoryRow[]>> {
  const db = await createClient();
  return run(
    "v_order_status_history",
    db
      .from("v_order_status_history")
      .select("id, order_id, from_status, to_status, changed_at, reason, is_mine, changed_by_name_en, changed_by_name_ar")
      .eq("order_id", orderId)
      .order("id"),
    [],
  );
}

export const CUSTOMER_LIMIT = 500;

/**
 * Customers the user may sell to: those RLS shows them (the same crm.customer.read
 * scope api.save_order_draft checks), minus archived and blocked ones (CUSTOMER_BLOCKED).
 */
export async function listSellableCustomers(): Promise<Result<CustomerOption[]>> {
  const db = await createClient();
  return run(
    "v_customers",
    db
      .from("v_customers")
      .select("id, customer_no, display_name")
      .is("archived_at", null)
      .neq("lifecycle_stage", "blocked")
      .order("display_name")
      .limit(CUSTOMER_LIMIT),
    [],
  );
}

export const SEARCH_LIMIT = 20;

/** Catalogue search for the builder (no prices: the server prices the saved draft). */
export async function searchSellableVariants(raw: string): Promise<Result<SellableVariant[]>> {
  const q = sanitizeSearch(raw);
  if (q.length < 2) return ok([]);
  const db = await createClient();
  const pattern = `%${q}%`;
  return run(
    "v_sellable_variants",
    db
      .from("v_sellable_variants")
      .select(VARIANT_COLUMNS)
      .or(
        [
          `sku.ilike.${pattern}`,
          `variant_name.ilike.${pattern}`,
          `product_code.ilike.${pattern}`,
          `product_name_en.ilike.${pattern}`,
          `product_name_ar.ilike.${pattern}`,
        ].join(","),
      )
      .order("sku")
      .limit(SEARCH_LIMIT),
    [],
  );
}

const CATALOG_PAGE = 1000;

/**
 * The sellable-variant list for the device cache (offline search), with the
 * DEFAULT list's single-unit price as an indicative price (api.v_catalog_variants
 * default_price; NULL without catalog.price.read). Up to `limit` variants, read in
 * pages; `truncated` says the catalogue was larger. A failed price read keeps the
 * list (prices are only indicative); a failed list read fails the snapshot.
 */
export async function listSellableCatalog(limit: number): Promise<Result<{ variants: CachedVariant[]; truncated: boolean }>> {
  const db = await createClient();
  const variants: SellableVariant[] = [];
  for (let from = 0; from <= limit; from += CATALOG_PAGE) {
    const to = Math.min(from + CATALOG_PAGE, limit + 1) - 1;
    const page = await run<SellableVariant[]>(
      "v_sellable_variants",
      db.from("v_sellable_variants").select(VARIANT_COLUMNS).order("sku").order("variant_id").range(from, to),
      [],
    );
    if (!page.ok) return page;
    variants.push(...page.data);
    if (page.data.length < to - from + 1) break;
  }
  const truncated = variants.length > limit;
  if (truncated) variants.length = limit;

  const prices = new Map<string, number>();
  for (let from = 0; from <= limit; from += CATALOG_PAGE) {
    const to = Math.min(from + CATALOG_PAGE, limit + 1) - 1;
    const page = await run<{ id: string; default_price: number | string | null }[]>(
      "v_catalog_variants",
      db
        .from("v_catalog_variants")
        .select("id, default_price")
        .eq("is_sellable", true)
        .not("default_price", "is", null)
        .order("id")
        .range(from, to),
      [],
    );
    if (!page.ok) break;
    for (const row of page.data) {
      const n = toNumber(row.default_price);
      if (n > 0) prices.set(row.id, n);
    }
    if (page.data.length < to - from + 1) break;
  }
  return ok({ variants: variants.map((v) => ({ ...v, price: prices.get(v.variant_id) ?? null })), truncated });
}

/** Sellable availability of the order's variants per warehouse (RLS: inventory.stock.read). */
export async function stockForVariants(variantIds: readonly string[]): Promise<Result<StockAvailableRow[]>> {
  if (variantIds.length === 0) return ok([]);
  const db = await createClient();
  return run(
    "v_stock_available",
    db
      .from("v_stock_available")
      .select("warehouse_id, warehouse_code, warehouse_name, variant_id, available")
      .in("variant_id", [...variantIds]),
    [],
  );
}
