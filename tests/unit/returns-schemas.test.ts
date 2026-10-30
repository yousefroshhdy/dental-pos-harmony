import { describe, expect, it } from "vitest";
import { creditReturnSchema, formToObject, receiveReturnSchema, requestLineSchema, requestReturnSchema } from "@/modules/returns/schemas";

const ORDER = "f3500000-0000-0000-0000-00000000000a";
const ITEM = "a0000000-0000-0000-0000-000000000001";
const LOT = "61000000-0000-0000-0000-000000000001";
const REF = "c3500000-0000-0000-0000-000000000001";
const line = { order_item_id: ITEM, lot_id: LOT, quantity: 2, reason_code: "damaged" };

describe("returns schemas", () => {
  it("formToObject trims and drops empty values", () => {
    const form = new FormData();
    form.set("a", "  x ");
    form.set("b", "   ");
    expect(formToObject(form)).toEqual({ a: "x" });
  });

  it("accepts a valid request and parses its lines", () => {
    const parsed = requestReturnSchema.safeParse({ order_id: ORDER, locale: "ar", client_ref: REF, lines: JSON.stringify([line]) });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lines).toEqual([line]);
  });

  it("refuses lines carrying anything but ids, quantity and reason (never a price)", () => {
    expect(requestLineSchema.safeParse({ ...line, unit_price: 1 }).success).toBe(false);
    expect(requestLineSchema.safeParse({ ...line, total: 1 }).success).toBe(false);
    expect(requestLineSchema.safeParse({ ...line, quantity: 1.5 }).success).toBe(false);
    expect(requestLineSchema.safeParse({ ...line, quantity: 0 }).success).toBe(false);
    expect(requestLineSchema.safeParse({ ...line, reason_code: "bored" }).success).toBe(false);
  });

  it("refuses an empty, malformed or unkeyed request", () => {
    const base = { order_id: ORDER, locale: "en", client_ref: REF };
    expect(requestReturnSchema.safeParse({ ...base, lines: "[]" }).success).toBe(false);
    expect(requestReturnSchema.safeParse({ ...base, lines: "not json" }).success).toBe(false);
    expect(requestReturnSchema.safeParse({ order_id: ORDER, locale: "en", lines: JSON.stringify([line]) }).success).toBe(false);
    expect(requestReturnSchema.safeParse({ ...base, locale: "fr", lines: JSON.stringify([line]) }).success).toBe(false);
    expect(requestReturnSchema.safeParse({ ...base, notes: "x".repeat(1001), lines: JSON.stringify([line]) }).success).toBe(false);
  });

  it("receive and credit need ids and a device idempotency key", () => {
    const key = "3f1c0a52-4b8e-4d7a-9a51-0c2f5e6d7b8a";
    expect(receiveReturnSchema.safeParse({ return_id: ITEM, warehouse_id: LOT, idempotency_key: key }).success).toBe(true);
    expect(receiveReturnSchema.safeParse({ return_id: ITEM, idempotency_key: key }).success).toBe(false);
    expect(creditReturnSchema.safeParse({ return_id: ITEM, idempotency_key: key }).success).toBe(true);
    expect(creditReturnSchema.safeParse({ return_id: ITEM, idempotency_key: "short" }).success).toBe(false);
    expect(creditReturnSchema.safeParse({ return_id: "x", idempotency_key: key }).success).toBe(false);
  });
});
