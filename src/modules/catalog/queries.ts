import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type {
  BrandRow,
  CategoryRow,
  CustomerOption,
  CustomerPriceListRow,
  PriceListItemRow,
  PriceListRow,
  ProductRow,
  PromotionRow,
  VariantRow,
} from "./types";

/**
 * Catalogue reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides what comes back: no price rows without
 * catalog.price.read, and no purchase cost in any of them.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "catalog.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "catalog.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

/** Upper bound for admin lists; the catalogue is hundreds of SKUs, not millions. */
const LIST_LIMIT = 2000;

const PRODUCT_COLUMNS =
  "id, code, name_en, name_ar, description, status, brand_id, brand_code, brand_name, category_id, category_code, category_name_en, category_name_ar, is_lot_tracked, is_expiry_tracked, is_serial_tracked, tax_rate_pct, variant_count, active_variant_count, created_at, updated_at";
const VARIANT_COLUMNS =
  "id, product_id, product_code, product_name_en, product_name_ar, product_status, brand_id, brand_code, brand_name, sku, name_en, attributes, barcode, uom, reorder_point, status, is_sellable, default_price, created_at";
const PRICE_LIST_COLUMNS =
  "id, code, name, kind, currency, priority, valid_from, valid_to, is_active, is_current, is_default, item_count, customer_count";
const ITEM_COLUMNS =
  "price_list_id, price_list_code, variant_id, sku, variant_name_en, variant_status, product_id, product_code, product_name_en, product_name_ar, product_status, min_qty, unit_price";
const ASSIGNMENT_COLUMNS =
  "customer_id, customer_no, customer_name, price_list_id, price_list_code, price_list_name, valid_from, valid_to, state";
const PROMOTION_COLUMNS =
  "id, name, discount_pct, min_qty, valid_from, valid_to, priority, is_active, brand_id, brand_code, brand_name, category_id, category_code, category_name_en, category_name_ar, variant_id, variant_sku, variant_name_en, customer_id, customer_no, customer_name, state";

export async function listBrands(): Promise<Result<BrandRow[]>> {
  const db = await createClient();
  return run("v_catalog_brands", db.from("v_catalog_brands").select("id, code, name, country_of_origin, is_active").order("code"), []);
}

export async function listCategories(): Promise<Result<CategoryRow[]>> {
  const db = await createClient();
  return run("v_catalog_categories", db.from("v_catalog_categories").select("id, code, name_en, name_ar, parent_id").order("code"), []);
}

export async function listProducts(): Promise<Result<ProductRow[]>> {
  const db = await createClient();
  return run("v_catalog_products", db.from("v_catalog_products").select(PRODUCT_COLUMNS).order("code").limit(LIST_LIMIT), []);
}

export async function getProduct(productId: string): Promise<Result<ProductRow | null>> {
  const db = await createClient();
  return run("v_catalog_products", db.from("v_catalog_products").select(PRODUCT_COLUMNS).eq("id", productId).maybeSingle(), null);
}

export async function listVariants(productId?: string): Promise<Result<VariantRow[]>> {
  const db = await createClient();
  let query = db.from("v_catalog_variants").select(VARIANT_COLUMNS);
  if (productId) query = query.eq("product_id", productId);
  return run("v_catalog_variants", query.order("sku").limit(LIST_LIMIT), []);
}

/** Sellable SKUs for pickers (price items, promotions). */
export async function listSellableSkus(): Promise<Result<Pick<VariantRow, "id" | "sku" | "name_en">[]>> {
  const db = await createClient();
  return run(
    "v_catalog_variants",
    db.from("v_catalog_variants").select("id, sku, name_en").eq("is_sellable", true).order("sku").limit(LIST_LIMIT),
    [],
  );
}

export async function findVariantBySku(sku: string): Promise<Result<Pick<VariantRow, "id" | "sku"> | null>> {
  const db = await createClient();
  return run("v_catalog_variants", db.from("v_catalog_variants").select("id, sku").eq("sku", sku.toUpperCase()).maybeSingle(), null);
}

export async function listPriceLists(): Promise<Result<PriceListRow[]>> {
  const db = await createClient();
  return run(
    "v_price_lists",
    db.from("v_price_lists").select(PRICE_LIST_COLUMNS).order("kind").order("priority").order("code").limit(LIST_LIMIT),
    [],
  );
}

export async function getPriceList(priceListId: string): Promise<Result<PriceListRow | null>> {
  const db = await createClient();
  return run("v_price_lists", db.from("v_price_lists").select(PRICE_LIST_COLUMNS).eq("id", priceListId).maybeSingle(), null);
}

export async function listPriceListItems(filter: { priceListId?: string; productId?: string }): Promise<Result<PriceListItemRow[]>> {
  const db = await createClient();
  let query = db.from("v_price_list_items").select(ITEM_COLUMNS);
  if (filter.priceListId) query = query.eq("price_list_id", filter.priceListId);
  if (filter.productId) query = query.eq("product_id", filter.productId);
  return run("v_price_list_items", query.order("sku").order("min_qty").limit(LIST_LIMIT), []);
}

export async function listCustomerAssignments(priceListId: string): Promise<Result<CustomerPriceListRow[]>> {
  const db = await createClient();
  return run(
    "v_customer_price_lists",
    db
      .from("v_customer_price_lists")
      .select(ASSIGNMENT_COLUMNS)
      .eq("price_list_id", priceListId)
      .order("valid_from", { ascending: false })
      .limit(LIST_LIMIT),
    [],
  );
}

/** Customer by number, within the caller's CRM scope (api.v_customers is RLS-filtered). */
export async function findCustomerByNo(customerNo: string): Promise<Result<CustomerOption | null>> {
  const db = await createClient();
  return run(
    "v_customers",
    db.from("v_customers").select("id, customer_no, display_name").eq("customer_no", customerNo.toUpperCase()).maybeSingle(),
    null,
  );
}

export async function listPromotions(): Promise<Result<PromotionRow[]>> {
  const db = await createClient();
  return run("v_promotions", db.from("v_promotions").select(PROMOTION_COLUMNS).order("valid_from", { ascending: false }).limit(LIST_LIMIT), []);
}
