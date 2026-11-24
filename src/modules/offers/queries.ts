import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { OfferCustomerRow, OfferItemRow, OfferRow } from "./types";

/**
 * Offer reads, through the user's session against api.v_offer* (security_invoker):
 * RLS on sales.offers shows offers to sellers and price readers; a customer target
 * only when the customer itself is visible.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "offers.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "offers.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const OFFER_COLUMNS =
  "id, code, name_en, name_ar, description, pricing_mode, package_price, valid_from, valid_to, target_tags, is_active, " +
  "version, created_at, updated_at, is_current, paid_items, bonus_items, target_customer_count, is_targeted";

export const OFFER_LIST_LIMIT = 300;

export async function listOffers(): Promise<Result<OfferRow[]>> {
  const db = await createClient();
  return run("v_offers", db.from("v_offers").select(OFFER_COLUMNS).order("valid_from", { ascending: false }).order("code").limit(OFFER_LIST_LIMIT), []);
}

export async function getOffer(id: string): Promise<Result<OfferRow | null>> {
  const db = await createClient();
  return run("v_offers", db.from("v_offers").select(OFFER_COLUMNS).eq("id", id).maybeSingle(), null);
}

export async function listOfferItems(id: string): Promise<Result<OfferItemRow[]>> {
  const db = await createClient();
  return run(
    "v_offer_items",
    db
      .from("v_offer_items")
      .select("id, offer_id, offer_code, line_no, variant_id, sku, variant_name, product_name_en, product_name_ar, quantity, is_bonus, net_unit_price")
      .eq("offer_id", id)
      .order("line_no"),
    [],
  );
}

export async function listOfferCustomers(id: string): Promise<Result<OfferCustomerRow[]>> {
  const db = await createClient();
  return run(
    "v_offer_customers",
    db.from("v_offer_customers").select("offer_id, customer_id, customer_no, customer_name").eq("offer_id", id).order("customer_no").limit(500),
    [],
  );
}

/** Customer ids for customer numbers the user can see (targeting by number). */
export async function customersByNo(nos: readonly string[]): Promise<Result<{ id: string; customer_no: string }[]>> {
  if (nos.length === 0) return ok([]);
  const db = await createClient();
  return run("v_customers", db.from("v_customers").select("id, customer_no").in("customer_no", [...nos]).limit(500), []);
}

export interface VatProductRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  status: string;
  brand_name: string | null;
  category_name_en: string | null;
  category_name_ar: string | null;
  tax_rate_pct: number | string;
}

/** Products with their VAT rate (api.v_catalog_products), for the owner's VAT screen. */
export async function listVatProducts(): Promise<Result<VatProductRow[]>> {
  const db = await createClient();
  return run(
    "v_catalog_products",
    db
      .from("v_catalog_products")
      .select("id, code, name_en, name_ar, status, brand_name, category_name_en, category_name_ar, tax_rate_pct")
      .neq("status", "discontinued")
      .order("code")
      .limit(2000),
    [],
  );
}
