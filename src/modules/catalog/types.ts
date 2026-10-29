import type { TranslatedCode } from "@/lib/errors";

/**
 * Row shapes of the catalogue read views (supabase/migrations/20261030000600_catalog_commands.sql).
 * numeric columns may arrive from PostgREST as a number or a string.
 */
export type Numeric = number | string;

export type ProductStatus = "draft" | "active" | "discontinued";
export type VariantStatus = "active" | "discontinued";
export type PriceListKind = "standard" | "customer" | "promotional";
export type AssignmentState = "current" | "scheduled" | "ended" | "cancelled";
export type PromotionState = "active" | "scheduled" | "ended";

export interface BrandRow {
  id: string;
  code: string;
  name: string;
  country_of_origin: string | null;
  is_active: boolean;
}

export interface CategoryRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
  parent_id: string | null;
}

export interface ProductRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  status: ProductStatus;
  brand_id: string;
  brand_code: string;
  brand_name: string;
  category_id: string;
  category_code: string;
  category_name_en: string;
  category_name_ar: string;
  is_lot_tracked: boolean;
  is_expiry_tracked: boolean;
  is_serial_tracked: boolean;
  tax_rate_pct: Numeric;
  variant_count: number;
  active_variant_count: number;
  created_at: string;
  updated_at: string;
}

export interface VariantRow {
  id: string;
  product_id: string;
  product_code: string;
  product_name_en: string;
  product_name_ar: string | null;
  product_status: ProductStatus;
  brand_id: string;
  brand_code: string;
  brand_name: string;
  sku: string;
  name_en: string;
  attributes: Record<string, string | number | boolean> | null;
  barcode: string | null;
  uom: string;
  reorder_point: number;
  status: VariantStatus;
  is_sellable: boolean;
  /** DEFAULT list, quantity 1. NULL without catalog.price.read or when unpriced. */
  default_price: Numeric | null;
  created_at: string;
}

export interface PriceListRow {
  id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  currency: string;
  priority: number;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  is_current: boolean;
  is_default: boolean;
  item_count: number;
  customer_count: number;
}

export interface PriceListItemRow {
  price_list_id: string;
  price_list_code: string;
  variant_id: string;
  sku: string;
  variant_name_en: string;
  variant_status: VariantStatus;
  product_id: string;
  product_code: string;
  product_name_en: string;
  product_name_ar: string | null;
  product_status: ProductStatus;
  min_qty: number;
  unit_price: Numeric;
}

export interface CustomerPriceListRow {
  customer_id: string;
  customer_no: string | null;
  customer_name: string;
  price_list_id: string;
  price_list_code: string;
  price_list_name: string;
  valid_from: string;
  valid_to: string | null;
  state: AssignmentState;
}

export interface PromotionRow {
  id: string;
  name: string;
  discount_pct: Numeric;
  min_qty: number;
  valid_from: string;
  valid_to: string | null;
  priority: number;
  is_active: boolean;
  brand_id: string | null;
  brand_code: string | null;
  brand_name: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name_en: string | null;
  category_name_ar: string | null;
  variant_id: string | null;
  variant_sku: string | null;
  variant_name_en: string | null;
  customer_id: string | null;
  customer_no: string | null;
  customer_name: string | null;
  state: PromotionState;
}

/** A customer option for the price-list assignment form (api.v_customers, RLS-filtered). */
export interface CustomerOption {
  id: string;
  customer_no: string | null;
  display_name: string;
}

/**
 * Result of a catalogue Server Action. `code` is the business code from the database
 * (e.g. DUPLICATE_SKU); the UI shows catalog.errors.<code> when it exists, otherwise
 * errors.<messageKey>. No SQL text reaches the browser.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; code: string; messageKey: TranslatedCode; requestId?: string; fields?: string[] };
export type ActionState = ActionResult | null;
