import { describe, expect, it } from "vitest";
import { draftLineSchema, draftPayloadSchema, formToObject, fulfilSchema, orderReasonSchema, reserveSchema } from "@/modules/orders/schemas";

const ORDER = "71000000-0000-0000-0000-00000000000a";
const CUSTOMER = "40000000-0000-0000-0000-000000000001";
const VARIANT = "53000000-0000-0000-0000-000000000001";

const draft = (lines: unknown, extra: Record<string, unknown> = {}) => ({
  order_id: ORDER,
  customer_id: CUSTOMER,
  lines,
  notes: null,
  visit_id: null,
  version: null,
  ...extra,
});

describe("draft lines: ids, quantities and what the seller asks for", () => {
  it("accepts a variant id and a whole quantity", () => {
    expect(draftLineSchema.safeParse({ variant_id: VARIANT, quantity: 3 }).success).toBe(true);
  });

  it.each([
    ["a requested discount", { variant_id: VARIANT, quantity: 1, requested_discount_pct: 24 }],
    ["a net price typed by the seller", { variant_id: VARIANT, quantity: 2, net_unit_price: 2723.45 }],
    ["a free (bonus) line", { variant_id: VARIANT, quantity: 3, is_bonus: true }],
  ])("accepts %s (the server converts and checks it)", (_label, line) => {
    expect(draftLineSchema.safeParse(line).success).toBe(true);
  });

  it.each([
    ["a list price", { variant_id: VARIANT, quantity: 1, list_price: 1 }],
    ["a total", { variant_id: VARIANT, quantity: 1, line_total: 10 }],
    ["a tax", { variant_id: VARIANT, quantity: 1, line_tax: 10 }],
    ["a discount above 100 %", { variant_id: VARIANT, quantity: 1, requested_discount_pct: 120 }],
    ["a discount of 0", { variant_id: VARIANT, quantity: 1, requested_discount_pct: 0 }],
    ["a net price with 3 decimals", { variant_id: VARIANT, quantity: 1, net_unit_price: 2723.455 }],
    ["both a discount and a net price", { variant_id: VARIANT, quantity: 1, requested_discount_pct: 5, net_unit_price: 900 }],
    ["a bonus line with a discount", { variant_id: VARIANT, quantity: 1, is_bonus: true, requested_discount_pct: 5 }],
    ["is_bonus false (omit it instead)", { variant_id: VARIANT, quantity: 1, is_bonus: false }],
  ])("rejects a line carrying %s", (_label, line) => {
    expect(draftLineSchema.safeParse(line).success).toBe(false);
  });

  it("an offer line is an offer id and a package count, nothing else", () => {
    expect(draftPayloadSchema.safeParse(draft([{ offer_id: VARIANT, quantity: 2 }])).success).toBe(true);
    expect(draftPayloadSchema.safeParse(draft([{ offer_id: VARIANT, quantity: 2, package_price: 1 }])).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft([{ offer_id: VARIANT, quantity: 0 }])).success).toBe(false);
  });

  it("an invoice discount is an amount or a percentage", () => {
    const one = [{ variant_id: VARIANT, quantity: 1 }];
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: { amount: 100 } })).success).toBe(true);
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: { pct: 5 } })).success).toBe(true);
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: null })).success).toBe(true);
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: { amount: 100, pct: 5 } })).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: { total: 100 } })).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft(one, { invoice_discount: { pct: 101 } })).success).toBe(false);
  });

  it.each([0, -1, 1.5, 100_001, "2"])("rejects quantity %p", (quantity) => {
    expect(draftLineSchema.safeParse({ variant_id: VARIANT, quantity }).success).toBe(false);
  });
});

describe("draftPayloadSchema", () => {
  it("accepts a device payload with an optional base version", () => {
    const parsed = draftPayloadSchema.parse(draft([{ variant_id: VARIANT, quantity: 2 }], { version: 3, notes: "deliver Sunday" }));
    expect(parsed.lines).toEqual([{ variant_id: VARIANT, quantity: 2 }]);
    expect(parsed.version).toBe(3);
    expect(draftPayloadSchema.parse(draft([{ variant_id: VARIANT, quantity: 2 }])).version).toBeNull();
  });

  it("rejects empty orders, bad ids and a version below 1", () => {
    expect(draftPayloadSchema.safeParse(draft([])).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft([{ variant_id: VARIANT, quantity: 1 }], { order_id: "x" })).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft([{ variant_id: VARIANT, quantity: 1 }], { version: 0 })).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft([{ variant_id: VARIANT, quantity: 1 }], { version: "2" })).success).toBe(false);
  });

  it("is strict: any extra key (a total, a price) is rejected", () => {
    expect(draftPayloadSchema.safeParse(draft([{ variant_id: VARIANT, quantity: 1 }], { total: 10 })).success).toBe(false);
    expect(draftPayloadSchema.safeParse(draft([{ variant_id: VARIANT, quantity: 1, list_price: 1 }])).success).toBe(false);
  });

  it("rejects more than 200 lines", () => {
    const many = Array.from({ length: 201 }, () => ({ variant_id: VARIANT, quantity: 1 }));
    expect(draftPayloadSchema.safeParse(draft(many)).success).toBe(false);
  });
});

describe("command schemas", () => {
  it("reason needs at least 3 characters", () => {
    expect(orderReasonSchema.safeParse({ order_id: ORDER, locale: "en", reason: "ok" }).success).toBe(false);
    expect(orderReasonSchema.safeParse({ order_id: ORDER, locale: "en", reason: "wrong customer" }).success).toBe(true);
  });

  it("reserve needs a warehouse id", () => {
    expect(reserveSchema.safeParse({ order_id: ORDER, locale: "en" }).success).toBe(false);
    expect(reserveSchema.safeParse({ order_id: ORDER, locale: "en", warehouse_id: "60000000-0000-0000-0000-000000000001" }).success).toBe(true);
  });

  it("fulfilment needs a device-generated idempotency key", () => {
    expect(fulfilSchema.safeParse({ order_id: ORDER, locale: "en" }).success).toBe(false);
    expect(fulfilSchema.safeParse({ order_id: ORDER, locale: "en", idempotency_key: "9c1e8a52-1111-4222-8333-444455556666" }).success).toBe(true);
    expect(fulfilSchema.safeParse({ order_id: ORDER, locale: "en", idempotency_key: "a,b;drop" }).success).toBe(false);
  });

  it("formToObject trims and drops empty values", () => {
    const form = new FormData();
    form.set("reason", "  late  ");
    form.set("notes", "   ");
    expect(formToObject(form)).toEqual({ reason: "late" });
  });
});
