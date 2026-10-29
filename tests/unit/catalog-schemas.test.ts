import { describe, expect, it } from "vitest";
import {
  formToObject,
  priceItemSchema,
  priceListSchema,
  productSchema,
  promotionSchema,
  variantSchema,
} from "@/modules/catalog/schemas";

const ID = "e2400000-0000-0000-0000-000000000001";
const ID2 = "e2400000-0000-0000-0000-000000000002";

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return formToObject(f);
};

describe("productSchema", () => {
  const base = { product_id: ID, brand_id: ID2, category_id: ID2, code: "test-impl-001", name_en: "Synthetic Test Implant", mode: "create", locale: "ar" };

  it("upper-cases the code and reads checkboxes", () => {
    const parsed = productSchema.parse(form({ ...base, is_lot_tracked: "on", description: "  " }));
    expect(parsed.code).toBe("TEST-IMPL-001");
    expect(parsed.is_lot_tracked).toBe(true);
    expect(parsed.is_expiry_tracked).toBe(false);
    expect(parsed.description).toBeUndefined();
  });

  it("rejects bad codes and short names", () => {
    expect(productSchema.safeParse(form({ ...base, code: "x" })).success).toBe(false);
    expect(productSchema.safeParse(form({ ...base, code: "has space" })).success).toBe(false);
    expect(productSchema.safeParse(form({ ...base, name_en: "A" })).success).toBe(false);
  });

  it("never accepts a discontinued initial status", () => {
    expect(productSchema.safeParse(form({ ...base, status: "discontinued" })).success).toBe(false);
  });
});

describe("variantSchema", () => {
  const base = { variant_id: ID, product_id: ID2, sku: "test-impl-001-3510", name_en: "Synthetic 3.5x10" };

  it("normalises SKU, attributes, uom and reorder point", () => {
    const parsed = variantSchema.parse(form({ ...base, attributes: "diameter_mm=3.5\nlength_mm=10", uom: "BOX" }));
    expect(parsed.sku).toBe("TEST-IMPL-001-3510");
    expect(parsed.attributes).toEqual({ diameter_mm: 3.5, length_mm: 10 });
    expect(parsed.uom).toBe("box");
    expect(parsed.reorder_point).toBe(0);
  });

  it("flags malformed attributes on the attributes field", () => {
    const result = variantSchema.safeParse(form({ ...base, attributes: "not a pair" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe("attributes");
  });

  it("rejects negative reorder points", () => {
    expect(variantSchema.safeParse(form({ ...base, reorder_point: "-1" })).success).toBe(false);
  });
});

describe("priceItemSchema", () => {
  it("keeps the price as a decimal string and needs a variant or SKU", () => {
    const parsed = priceItemSchema.parse(form({ price_list_id: ID, sku: "bio-top-4110", unit_price: "1250.50" }));
    expect(parsed.unit_price).toBe("1250.50");
    expect(parsed.sku).toBe("BIO-TOP-4110");
    expect(parsed.min_qty).toBe(1);
    expect(priceItemSchema.safeParse(form({ price_list_id: ID, unit_price: "10" })).success).toBe(false);
  });

  it("rejects zero, negative and over-precise prices", () => {
    for (const unit_price of ["0", "-1", "10.001", "abc"]) {
      expect(priceItemSchema.safeParse(form({ price_list_id: ID, variant_id: ID2, unit_price })).success).toBe(false);
    }
  });
});

describe("priceListSchema", () => {
  const base = { price_list_id: ID, code: "test-vip", name: "Synthetic VIP", kind: "customer", priority: "10", valid_from: "2026-11-01", mode: "create", locale: "en" };

  it("parses a list and its dates", () => {
    const parsed = priceListSchema.parse(form({ ...base, is_active: "on" }));
    expect(parsed).toMatchObject({ code: "TEST-VIP", priority: 10, is_active: true });
    expect(parsed.valid_to).toBeUndefined();
  });

  it("rejects an end date before the start", () => {
    expect(priceListSchema.safeParse(form({ ...base, valid_to: "2026-10-31" })).success).toBe(false);
    expect(priceListSchema.safeParse(form({ ...base, priority: "0" })).success).toBe(false);
  });
});

describe("promotionSchema", () => {
  const base = { promotion_id: ID, name: "Synthetic week", discount_pct: "10", valid_from: "2026-11-01" };

  it("defaults quantity and priority", () => {
    expect(promotionSchema.parse(form(base))).toMatchObject({ min_qty: 1, priority: 100, discount_pct: "10" });
  });

  it("rejects 0% and more than 100%", () => {
    expect(promotionSchema.safeParse(form({ ...base, discount_pct: "0" })).success).toBe(false);
    expect(promotionSchema.safeParse(form({ ...base, discount_pct: "101" })).success).toBe(false);
  });
});
