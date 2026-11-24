import type { TableParamOptions } from "@/components/ui/data-table-params";
import type { ProductStatus } from "./types";

/** The product list as a server-paged table (Phase P step 2b). */
export const PRODUCTS_TABLE = {
  pageSize: 25,
  sortable: ["code", "name", "brand", "status", "updated_at"],
  defaultSort: { id: "code", desc: false },
} as const satisfies TableParamOptions;

export const PRODUCT_STATUSES: readonly ProductStatus[] = ["active", "draft", "discontinued"];

export const PRODUCT_SEARCH_COLUMNS = ["code", "name_en", "name_ar"] as const;
/** A typed SKU or barcode also finds its product (looked up in the variants first). */
export const VARIANT_SEARCH_COLUMNS = ["sku", "barcode", "name_en"] as const;

export function productSortColumn(id: string | undefined, locale: string): string {
  switch (id) {
    case "name":
      return locale === "ar" ? "name_ar" : "name_en";
    case "brand":
      return "brand_name";
    case "status":
    case "updated_at":
      return id;
    default:
      return "code";
  }
}

/** "1–3 of 4": lowest and highest default price of a product's sellable variants (null when none is priced). */
export function priceRange(prices: readonly (number | null)[]): { min: number; max: number } | null {
  const known = prices.filter((p): p is number => p !== null && Number.isFinite(p));
  if (known.length === 0) return null;
  return { min: Math.min(...known), max: Math.max(...known) };
}
