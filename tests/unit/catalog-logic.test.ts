import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  attributeSummary,
  canManagePrices,
  canManageProducts,
  catalogErrorCode,
  dateOnly,
  filterProducts,
  formatAttributes,
  groupVariantsByProduct,
  isValidPercent,
  isValidPrice,
  parseAttributes,
  productStatusActions,
  promotionTargets,
  sortPromotions,
  todayInCairo,
  variantStatusAction,
} from "@/modules/catalog/logic";
import type { ProductRow, PromotionRow, VariantRow } from "@/modules/catalog/types";

const ctx = (permissions: UserContext["permissions"], extra: Partial<UserContext> = {}): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: "u",
  active: true,
  status: "active",
  permissions,
  ...extra,
});

const product = (over: Partial<ProductRow>): ProductRow => ({
  id: "p1",
  code: "TEST-IMPL-001",
  name_en: "Synthetic Test Implant",
  name_ar: null,
  description: null,
  status: "active",
  brand_id: "b1",
  brand_code: "BIONER",
  brand_name: "Bioner",
  category_id: "c1",
  category_code: "IMPLANT",
  category_name_en: "Implants",
  category_name_ar: "زرعات",
  is_lot_tracked: true,
  is_expiry_tracked: false,
  is_serial_tracked: false,
  tax_rate_pct: "14.00",
  variant_count: 0,
  active_variant_count: 0,
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
  ...over,
});

const variant = (over: Partial<VariantRow>): VariantRow => ({
  id: "v1",
  product_id: "p1",
  product_code: "TEST-IMPL-001",
  product_name_en: "Synthetic Test Implant",
  product_name_ar: null,
  product_status: "active",
  brand_id: "b1",
  brand_code: "BIONER",
  brand_name: "Bioner",
  sku: "TEST-IMPL-001-3510",
  name_en: "Synthetic 3.5x10",
  attributes: {},
  barcode: null,
  uom: "unit",
  reorder_point: 0,
  status: "active",
  is_sellable: true,
  default_price: "1000.00",
  created_at: "2026-10-29T00:00:00Z",
  ...over,
});

const promo = (over: Partial<PromotionRow>): PromotionRow => ({
  id: "x",
  name: "Synthetic promo",
  discount_pct: "5.00",
  min_qty: 1,
  valid_from: "2026-10-01",
  valid_to: null,
  priority: 100,
  is_active: true,
  brand_id: null,
  brand_code: null,
  brand_name: null,
  category_id: null,
  category_code: null,
  category_name_en: null,
  category_name_ar: null,
  variant_id: null,
  variant_sku: null,
  variant_name_en: null,
  customer_id: null,
  customer_no: null,
  customer_name: null,
  state: "active",
  ...over,
});

describe("catalog permissions (UI gating only)", () => {
  it("needs company-wide scope to manage", () => {
    expect(canManageProducts(ctx({ "catalog.product.manage": { scope: "all", limit: null } }))).toBe(true);
    expect(canManageProducts(ctx({ "catalog.product.manage": { scope: "territory", limit: null } }))).toBe(false);
    expect(canManagePrices(ctx({ "catalog.product.manage": { scope: "all", limit: null } }))).toBe(false);
    expect(canManagePrices(ctx({}, { is_owner: true }))).toBe(true);
    expect(canManagePrices(ANONYMOUS_CONTEXT)).toBe(false);
  });
});

describe("status rules", () => {
  it("offers the right product moves", () => {
    expect(productStatusActions("draft")).toEqual(["active", "discontinued"]);
    expect(productStatusActions("active")).toEqual(["discontinued"]);
    expect(productStatusActions("discontinued")).toEqual(["active"]);
  });

  it("never offers reactivating a variant of a discontinued product", () => {
    expect(variantStatusAction({ status: "active", product_status: "active" })).toBe("discontinued");
    expect(variantStatusAction({ status: "discontinued", product_status: "active" })).toBe("active");
    expect(variantStatusAction({ status: "discontinued", product_status: "discontinued" })).toBeNull();
  });
});

describe("grouping and filtering", () => {
  const products = [product({ id: "p1" }), product({ id: "p2", code: "TEST-BUR-001", brand_code: "RDT", status: "discontinued" })];
  const variants = [
    variant({ id: "v2", sku: "TEST-IMPL-001-4010" }),
    variant({ id: "v1", sku: "TEST-IMPL-001-3510", barcode: "TEST-0001" }),
    variant({ id: "v3", product_id: "p2", sku: "TEST-BUR-001-A" }),
  ];
  const grouped = groupVariantsByProduct(products, variants);

  it("attaches variants sorted by SKU", () => {
    expect(grouped[0]?.variants.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(grouped[1]?.variants.map((v) => v.id)).toEqual(["v3"]);
  });

  it("searches codes, names, SKUs and barcodes case-insensitively", () => {
    expect(filterProducts(grouped, { q: "test-0001" }).map((p) => p.id)).toEqual(["p1"]);
    expect(filterProducts(grouped, { q: "bur-001-a" }).map((p) => p.id)).toEqual(["p2"]);
    expect(filterProducts(grouped, { brand: "RDT" }).map((p) => p.id)).toEqual(["p2"]);
    expect(filterProducts(grouped, { status: "active" }).map((p) => p.id)).toEqual(["p1"]);
    expect(filterProducts(grouped, {})).toHaveLength(2);
  });
});

describe("variant attributes", () => {
  it("parses key=value and key: value lines, keeping numbers and booleans", () => {
    expect(parseAttributes("diameter_mm=3.5\nLength mm: 10\n\nsterile=true\ncolor=blue")).toEqual({
      ok: true,
      value: { diameter_mm: 3.5, length_mm: 10, sterile: true, color: "blue" },
    });
    expect(parseAttributes("")).toEqual({ ok: true, value: {} });
  });

  it("rejects malformed lines with the line number", () => {
    expect(parseAttributes("diameter_mm=3.5\nno separator")).toEqual({ ok: false, line: 2 });
    expect(parseAttributes("1bad=3")).toEqual({ ok: false, line: 1 });
    expect(parseAttributes("a=1\na=2")).toEqual({ ok: false, line: 2 });
    expect(parseAttributes("a=")).toEqual({ ok: false, line: 1 });
  });

  it("round-trips through the textarea format", () => {
    const value = { diameter_mm: 3.5, length_mm: 10 };
    const parsed = parseAttributes(formatAttributes(value));
    expect(parsed).toEqual({ ok: true, value });
    expect(attributeSummary(value)).toBe("diameter_mm 3.5 · length_mm 10");
    expect(formatAttributes(null)).toBe("");
  });
});

describe("money and dates", () => {
  it("accepts EGP prices above 0 with at most 2 decimals", () => {
    expect(isValidPrice("1000")).toBe(true);
    expect(isValidPrice("999.99")).toBe(true);
    expect(isValidPrice("0")).toBe(false);
    expect(isValidPrice("0.00")).toBe(false);
    expect(isValidPrice("-5")).toBe(false);
    expect(isValidPrice("10.005")).toBe(false);
    expect(isValidPrice("1e3")).toBe(false);
    expect(isValidPrice("1,000")).toBe(false);
  });

  it("accepts percentages in (0, 100]", () => {
    expect(isValidPercent("10")).toBe(true);
    expect(isValidPercent("100")).toBe(true);
    expect(isValidPercent("2.5")).toBe(true);
    expect(isValidPercent("0")).toBe(false);
    expect(isValidPercent("100.01")).toBe(false);
  });

  it("uses the Cairo calendar day", () => {
    // 23:30 UTC on 29 Oct is already 30 Oct in Cairo (UTC+2 or +3).
    expect(todayInCairo(new Date("2026-10-29T23:30:00Z"))).toBe("2026-10-30");
    expect(dateOnly("2026-10-29").toISOString()).toBe("2026-10-29T00:00:00.000Z");
  });
});

describe("promotions", () => {
  it("describes targets, empty meaning everything", () => {
    expect(promotionTargets(promo({}), "en")).toEqual([]);
    expect(
      promotionTargets(promo({ brand_id: "b", brand_name: "Bioner", customer_id: "c", customer_no: "C-0001", customer_name: "Synthetic Clinic" }), "en"),
    ).toEqual([
      { kind: "brand", label: "Bioner" },
      { kind: "customer", label: "C-0001 · Synthetic Clinic" },
    ]);
    expect(promotionTargets(promo({ category_id: "c", category_name_en: "Burs", category_name_ar: "فرز" }), "ar")).toEqual([
      { kind: "category", label: "فرز" },
    ]);
  });

  it("sorts active, then scheduled, then ended", () => {
    const rows = [
      promo({ id: "e", state: "ended" }),
      promo({ id: "s", state: "scheduled" }),
      promo({ id: "a1", state: "active", valid_from: "2026-09-01" }),
      promo({ id: "a2", state: "active", valid_from: "2026-10-01" }),
    ];
    expect(sortPromotions(rows).map((r) => r.id)).toEqual(["a2", "a1", "s", "e"]);
  });
});

describe("error codes", () => {
  it("maps known business codes and ignores the rest", () => {
    expect(catalogErrorCode("DUPLICATE_SKU")).toBe("DUPLICATE_SKU");
    expect(catalogErrorCode("PERMISSION_DENIED")).toBeNull();
  });
});
