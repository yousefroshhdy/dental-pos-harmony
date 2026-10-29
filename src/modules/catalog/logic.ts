import { can, type UserContext } from "@/lib/authz/can";
import type {
  AssignmentState,
  PriceListKind,
  ProductRow,
  ProductStatus,
  PromotionRow,
  PromotionState,
  VariantRow,
  VariantStatus,
} from "./types";

/**
 * Pure display and form helpers for the catalogue screens. Nothing here decides
 * access: Postgres re-checks every permission (catalog.*.manage at scope "all").
 */

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Catalogue data is company-wide; the commands require scope "all". */
export const canManageProducts = (ctx: UserContext) => can(ctx, "catalog.product.manage", "all");
export const canManagePrices = (ctx: UserContext) => can(ctx, "catalog.price.manage", "all");
export const canReadProducts = (ctx: UserContext) => can(ctx, "catalog.product.read");
export const canReadPrices = (ctx: UserContext) => can(ctx, "catalog.price.read");

export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

export function productStatusTone(status: ProductStatus): BadgeTone {
  return status === "active" ? "success" : status === "draft" ? "warning" : "neutral";
}

export function variantStatusTone(status: VariantStatus): BadgeTone {
  return status === "active" ? "success" : "neutral";
}

export function promotionStateTone(state: PromotionState): BadgeTone {
  return state === "active" ? "success" : state === "scheduled" ? "info" : "neutral";
}

export function assignmentStateTone(state: AssignmentState): BadgeTone {
  return state === "current" ? "success" : state === "scheduled" ? "info" : "neutral";
}

export function priceListKindTone(kind: PriceListKind): BadgeTone {
  return kind === "customer" ? "info" : kind === "promotional" ? "warning" : "neutral";
}

/** Status moves offered for a product (the DB also blocks draft after the first order). */
export function productStatusActions(status: ProductStatus): ProductStatus[] {
  switch (status) {
    case "draft":
      return ["active", "discontinued"];
    case "active":
      return ["discontinued"];
    case "discontinued":
      return ["active"];
  }
}

/** A variant can be reactivated only while its product is not discontinued. */
export function variantStatusAction(variant: Pick<VariantRow, "status" | "product_status">): VariantStatus | null {
  if (variant.status === "active") return "discontinued";
  return variant.product_status === "discontinued" ? null : "active";
}

export interface ProductWithVariants extends ProductRow {
  variants: VariantRow[];
}

/** Attach variants to their products, keeping the product order and sorting variants by SKU. */
export function groupVariantsByProduct(products: ProductRow[], variants: VariantRow[]): ProductWithVariants[] {
  const byProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const list = byProduct.get(v.product_id) ?? [];
    list.push(v);
    byProduct.set(v.product_id, list);
  }
  return products.map((p) => ({
    ...p,
    variants: (byProduct.get(p.id) ?? []).sort((a, b) => a.sku.localeCompare(b.sku)),
  }));
}

export interface ProductFilter {
  q?: string;
  brand?: string;
  status?: string;
}

/** Text search over code, names and SKUs; brand by code; status exact. */
export function filterProducts(products: ProductWithVariants[], filter: ProductFilter): ProductWithVariants[] {
  const q = filter.q?.trim().toLowerCase();
  return products.filter((p) => {
    if (filter.brand && p.brand_code !== filter.brand) return false;
    if (filter.status && p.status !== filter.status) return false;
    if (!q) return true;
    const haystack = [p.code, p.name_en, p.name_ar ?? "", ...p.variants.flatMap((v) => [v.sku, v.name_en, v.barcode ?? ""])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

// ---------------------------------------------------------------------------
// Variant attributes: edited as "key=value" lines, stored as a flat JSON object.
// ---------------------------------------------------------------------------
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
export const MAX_ATTRIBUTES = 30;

/** Parse "key=value" (or "key: value") lines. Numbers and true/false keep their type. */
export function parseAttributes(text: string): { ok: true; value: Attributes } | { ok: false; line: number } {
  const value: Attributes = {};
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "") continue;
    const match = /^([^=:]+)[=:](.*)$/.exec(raw);
    if (!match) return { ok: false, line: i + 1 };
    const key = (match[1] ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const rawValue = (match[2] ?? "").trim();
    if (!ATTRIBUTE_KEY.test(key) || rawValue === "" || rawValue.length > 200 || key in value) return { ok: false, line: i + 1 };
    if (++count > MAX_ATTRIBUTES) return { ok: false, line: i + 1 };
    value[key] = NUMBER.test(rawValue) ? Number(rawValue) : rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
  }
  return { ok: true, value };
}

export function formatAttributes(attributes: Attributes | null | undefined): string {
  return Object.entries(attributes ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");
}

/** Short one-line summary, e.g. "diameter_mm 3.5 · length_mm 10". */
export function attributeSummary(attributes: Attributes | null | undefined): string {
  return Object.entries(attributes ?? {})
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------
/** EGP price as typed by an admin: > 0, up to 12 integer digits and 2 decimals. */
export const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function isValidPrice(raw: string): boolean {
  const s = raw.trim();
  return PRICE_PATTERN.test(s) && Number(s) > 0;
}

/** Percent above 0 and at most 100, up to 2 decimals. */
export function isValidPercent(raw: string): boolean {
  const s = raw.trim();
  return /^\d{1,3}(\.\d{1,2})?$/.test(s) && Number(s) > 0 && Number(s) <= 100;
}

export const toNumber = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** Today's date (YYYY-MM-DD) in Cairo, for date-input defaults. */
export function todayInCairo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A date-only value (YYYY-MM-DD) as a Date at UTC midnight; format it with timeZone "UTC". */
export function dateOnly(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------
export type PromotionTargetPart =
  | { kind: "brand"; label: string }
  | { kind: "category"; label: string }
  | { kind: "variant"; label: string }
  | { kind: "customer"; label: string };

/** What a promotion applies to; an empty list means every product for every customer. */
export function promotionTargets(row: PromotionRow, locale: string): PromotionTargetPart[] {
  const parts: PromotionTargetPart[] = [];
  if (row.brand_id) parts.push({ kind: "brand", label: row.brand_name ?? row.brand_code ?? "" });
  if (row.category_id) parts.push({ kind: "category", label: localizedName(locale, row.category_name_en, row.category_name_ar) });
  if (row.variant_id) parts.push({ kind: "variant", label: row.variant_sku ?? "" });
  if (row.customer_id) parts.push({ kind: "customer", label: [row.customer_no, row.customer_name].filter(Boolean).join(" · ") });
  return parts;
}

const PROMOTION_ORDER: Record<PromotionState, number> = { active: 0, scheduled: 1, ended: 2 };

/** Active first, then scheduled, then ended; newest start first within a group. */
export function sortPromotions(rows: PromotionRow[]): PromotionRow[] {
  return [...rows].sort(
    (a, b) => PROMOTION_ORDER[a.state] - PROMOTION_ORDER[b.state] || b.valid_from.localeCompare(a.valid_from) || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
/** Business codes with a message under catalog.errors.* (others fall back to errors.*). */
export const CATALOG_ERROR_CODES = [
  "DUPLICATE_CODE",
  "DUPLICATE_SKU",
  "DUPLICATE_BARCODE",
  "DEFAULT_LIST_PROTECTED",
  "OVERLAP",
  "INVALID_STATE",
  "SKU_NOT_FOUND",
  "CUSTOMER_NOT_FOUND",
  "ATTRIBUTES_INVALID",
] as const;
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

export function catalogErrorCode(code: string): CatalogErrorCode | null {
  return (CATALOG_ERROR_CODES as readonly string[]).includes(code) ? (code as CatalogErrorCode) : null;
}
