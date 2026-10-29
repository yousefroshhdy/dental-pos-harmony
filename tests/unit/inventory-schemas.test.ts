import { describe, expect, it } from "vitest";
import {
  adjustmentSchema,
  createReceiptSchema,
  createTransferSchema,
  formLines,
  RECEIPT_LINE_FIELDS,
  toReceiptItems,
  toTransferItems,
  TRANSFER_LINE_FIELDS,
  validationCode,
} from "@/modules/inventory/schemas";

const WH1 = "60000000-0000-0000-0000-000000000001";
const WH2 = "60000000-0000-0000-0000-000000000002";
const VAR = "53000000-0000-0000-0000-000000000001";
const LOT = "61000000-0000-0000-0000-000000000001";

function form(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("formLines", () => {
  it("zips repeated fields by position and drops blank lines", () => {
    const f = form([
      ["variant_id", VAR],
      ["lot_no", " L1 "],
      ["quantity", "3"],
      ["variant_id", ""],
      ["lot_no", ""],
      ["quantity", ""],
      ["variant_id", VAR],
      ["lot_no", "L2"],
      ["quantity", "5"],
    ]);
    expect(formLines(f, ["variant_id", "lot_no", "quantity"])).toEqual([
      { variant_id: VAR, lot_no: "L1", quantity: "3" },
      { variant_id: VAR, lot_no: "L2", quantity: "5" },
    ]);
  });

  it("returns no lines for an empty form", () => {
    expect(formLines(new FormData(), RECEIPT_LINE_FIELDS)).toEqual([]);
  });
});

describe("createReceiptSchema", () => {
  const base = { warehouse_id: WH1, supplier: "Synthetic Supplier", locale: "ar" };

  it("accepts lines and builds p_items with only the allowed keys", () => {
    const parsed = createReceiptSchema.parse({
      ...base,
      lines: [
        { variant_id: VAR, lot_no: "L1", expiry_date: "2027-05-31", quantity: "20", unit_cost: "550.456" },
        { variant_id: VAR, lot_no: "NO-LOT", quantity: "1" },
      ],
    });
    expect(toReceiptItems(parsed.lines)).toEqual([
      { variant_id: VAR, lot_no: "L1", expiry_date: "2027-05-31", quantity: 20, unit_cost: 550.46 },
      { variant_id: VAR, lot_no: "NO-LOT", quantity: 1 },
    ]);
  });

  it.each([
    ["no lines", []],
    ["fractional quantity", [{ variant_id: VAR, lot_no: "L1", quantity: "1.5" }]],
    ["zero quantity", [{ variant_id: VAR, lot_no: "L1", quantity: "0" }]],
    ["impossible date", [{ variant_id: VAR, lot_no: "L1", quantity: "1", expiry_date: "2027-02-30" }]],
    ["negative cost", [{ variant_id: VAR, lot_no: "L1", quantity: "1", unit_cost: "-1" }]],
    ["bad variant id", [{ variant_id: "x", lot_no: "L1", quantity: "1" }]],
  ])("rejects %s", (_name, lines) => {
    expect(createReceiptSchema.safeParse({ ...base, lines }).success).toBe(false);
  });

  it("maps an empty line list to NO_LINES", () => {
    const r = createReceiptSchema.safeParse({ ...base, lines: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(validationCode(r.error)).toBe("NO_LINES");
  });
});

describe("createTransferSchema", () => {
  it("parses variant:lot lines into p_items", () => {
    const lines = formLines(form([["line", `${VAR}:${LOT}`], ["quantity", "8"]]), TRANSFER_LINE_FIELDS);
    const parsed = createTransferSchema.parse({ from_warehouse_id: WH1, to_warehouse_id: WH2, locale: "en", lines });
    expect(toTransferItems(parsed.lines)).toEqual([{ variant_id: VAR, lot_id: LOT, quantity: 8 }]);
  });

  it("rejects the same source and destination with SAME_WAREHOUSE", () => {
    const r = createTransferSchema.safeParse({
      from_warehouse_id: WH1,
      to_warehouse_id: WH1,
      locale: "en",
      lines: [{ line: `${VAR}:${LOT}`, quantity: "1" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(validationCode(r.error)).toBe("SAME_WAREHOUSE");
  });

  it("rejects a malformed stock line", () => {
    const r = createTransferSchema.safeParse({ from_warehouse_id: WH1, to_warehouse_id: WH2, locale: "en", lines: [{ line: VAR, quantity: "1" }] });
    expect(r.success).toBe(false);
  });
});

describe("adjustmentSchema", () => {
  const base = { warehouse_id: WH1, line: `${VAR}:${LOT}`, direction: "out", quantity: "2", reason_code: "damaged", idempotency_key: "0b0d6a5e-1f1e-4a51-9c3d-2a4f5e6d7c8b" };

  it("accepts a valid request", () => {
    expect(adjustmentSchema.parse(base)).toMatchObject({ quantity: 2, direction: "out", line: { variantId: VAR, lotId: LOT } });
  });

  it("requires a note for 'other' (REASON_REQUIRED)", () => {
    const r = adjustmentSchema.safeParse({ ...base, reason_code: "other" });
    expect(r.success).toBe(false);
    if (!r.success) expect(validationCode(r.error)).toBe("REASON_REQUIRED");
    expect(adjustmentSchema.safeParse({ ...base, reason_code: "other", note: "shelf count" }).success).toBe(true);
  });

  it.each([
    ["unknown reason", { reason_code: "gift" }],
    ["signed quantity (direction carries the sign)", { quantity: "-2" }],
    ["missing idempotency key", { idempotency_key: "" }],
    ["unknown direction", { direction: "sideways" }],
  ])("rejects %s", (_name, patch) => {
    expect(adjustmentSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});
