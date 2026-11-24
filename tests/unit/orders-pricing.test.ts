import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDraft, saveLocalDraft, type KeyValueStorage } from "@/modules/orders/device-store";
import {
  addLine,
  adjustValid,
  approvalReasons,
  invoiceDiscountOf,
  linesToBuilder,
  offersFromLines,
  orderErrorCode,
  parseAmount,
  parseDecimal,
  parseDiscountPct,
  PRICES_INCLUDE_VAT,
  vatGroups,
} from "@/modules/orders/logic";
import { buildDraftPayload, canSaveDraft, NEW_SLOT, toCommandLines, toProductLine, type LocalDraft } from "@/modules/orders/offline-logic";
import { draftPayloadSchema } from "@/modules/orders/schemas";

/**
 * Phase P step 6: what the seller may ASK for (offers, bonus lines, a discount %
 * or net price per line, an invoice discount) and how it travels to
 * api.save_order_draft. The server prices it (suite 56); nothing here is a price.
 */
const ORDER = "56400000-0000-0000-0000-000000000001";
const CUSTOMER = "40000000-0000-0000-0000-000000000001";
const IMPLANT = "56200000-0000-0000-0000-000000000001";
const ABUTMENT = "56200000-0000-0000-0000-000000000002";
const OFFER = "56300000-0000-0000-0000-000000000001";
const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261125000210_pricing_orders.sql"), "utf8");

describe("typed numbers", () => {
  it("2 decimals at most; Arabic-Indic digits, ٫ and thousands separators accepted", () => {
    expect(parseDecimal("2723.45")).toBe(2723.45);
    expect(parseDecimal("٢٧٢٣٫٤٥")).toBe(2723.45);
    expect(parseDecimal("5,000")).toBe(5000);
    expect(parseDecimal("2723.455")).toBeNull();
    expect(parseDecimal("-5")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });
  it("a discount is 0 < pct ≤ 100; an amount is > 0", () => {
    expect(parseDiscountPct("45.53")).toBe(45.53);
    expect(parseDiscountPct("0")).toBeNull();
    expect(parseDiscountPct("100.01")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("0.01")).toBe(0.01);
    expect(adjustValid({ kind: "net", value: "" })).toBe(true);
    expect(adjustValid({ kind: "net", value: "2723,45x" })).toBe(false);
    expect(adjustValid({ kind: "discount", value: "24" })).toBe(true);
  });
});

describe("draft payload", () => {
  const lines = [
    { variant_id: IMPLANT, quantity: 2, sku: "SYN-V1", name: "Synthetic implant", adjust: { kind: "net" as const, value: "2723.45" } },
    { variant_id: ABUTMENT, quantity: 1, sku: "SYN-V2", name: "Synthetic abutment", bonus: true },
    { variant_id: ABUTMENT, quantity: 3, sku: "SYN-V2", name: "Synthetic abutment", adjust: { kind: "discount" as const, value: "24" } },
  ];

  it("offers first, then product lines with only the keys in use", () => {
    const p = buildDraftPayload({
      orderId: ORDER,
      customerId: CUSTOMER,
      lines,
      offers: [{ offer_id: OFFER, packages: 2 }],
      invoiceDiscount: { kind: "amount", value: "100" },
      notes: "",
      visitId: null,
      baseVersion: 0,
    });
    expect(p.lines).toEqual([
      { offer_id: OFFER, quantity: 2 },
      { variant_id: IMPLANT, quantity: 2, net_unit_price: 2723.45 },
      { variant_id: ABUTMENT, quantity: 1, is_bonus: true },
      { variant_id: ABUTMENT, quantity: 3, requested_discount_pct: 24 },
    ]);
    expect(p.invoice_discount).toEqual({ amount: 100 });
    expect(draftPayloadSchema.safeParse(p).success).toBe(true);
  });

  it("an empty or unreadable adjustment is the list price; no invoice discount key without one", () => {
    expect(toProductLine({ variant_id: IMPLANT, quantity: 1, adjust: { kind: "discount", value: "" } })).toEqual({ variant_id: IMPLANT, quantity: 1 });
    const p = buildDraftPayload({ orderId: ORDER, customerId: CUSTOMER, lines: [lines[0]!], notes: "", visitId: null, baseVersion: 0 });
    expect("invoice_discount" in p).toBe(false);
  });

  it("the command gets the old array without an invoice discount (same fingerprint as before), else the object form", () => {
    const plain = [{ variant_id: IMPLANT, quantity: 1 }];
    expect(toCommandLines(plain, null)).toEqual(plain);
    expect(toCommandLines(plain, undefined)).toEqual(plain);
    expect(toCommandLines(plain, { amount: 100 })).toEqual({ lines: plain, invoice_discount_amount: 100 });
    expect(toCommandLines(plain, { pct: 5 })).toEqual({ lines: plain, invoice_discount_pct: 5 });
    // Whatever else a line carries is not sent.
    expect(toCommandLines([{ variant_id: IMPLANT, quantity: 1, list_price: 1 } as never], null)).toEqual(plain);
  });

  it("the migration accepts exactly these keys", () => {
    expect(MIGRATION).toContain("k not in ('variant_id','quantity','requested_discount_pct','net_unit_price','is_bonus')");
    expect(MIGRATION).toContain("k not in ('offer_id','quantity')");
    expect(MIGRATION).toContain("k not in ('lines', 'invoice_discount_amount', 'invoice_discount_pct')");
  });

  it("canSaveDraft: an offer alone is enough; an unreadable price or package count blocks", () => {
    expect(canSaveDraft(CUSTOMER, [], [{ packages: 1 }])).toBe(true);
    expect(canSaveDraft(CUSTOMER, [], [{ packages: 0 }])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 1, adjust: { kind: "net", value: "x" } }])).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 1 }], [], { kind: "pct", value: "150" })).toBe(false);
    expect(canSaveDraft(CUSTOMER, [{ quantity: 1 }], [], { kind: "amount", value: "" })).toBe(true);
  });
});

describe("saved draft → builder", () => {
  const saved = [
    { variant_id: IMPLANT, quantity: 3, sku: "SYN-V1", variant_name: "Implant", offer_id: OFFER, offer_code: "PKG-3", offer_packages: 1, is_bonus: false },
    { variant_id: ABUTMENT, quantity: 3, sku: "SYN-V2", variant_name: "Abutment", offer_id: OFFER, offer_code: "PKG-3", offer_packages: 1, is_bonus: true },
    { variant_id: IMPLANT, quantity: 2, sku: "SYN-V1", variant_name: "Implant", requested_net_price: "2723.45", requested_discount_pct: "45.53" },
    { variant_id: ABUTMENT, quantity: 1, sku: "SYN-V2", variant_name: "Abutment", is_bonus: true },
  ];
  it("offer lines become the offer; other lines keep their bonus flag and the price asked", () => {
    expect(offersFromLines(saved)).toEqual([{ offer_id: OFFER, packages: 1, code: "PKG-3", name: "PKG-3" }]);
    expect(linesToBuilder(saved)).toEqual([
      { variant_id: IMPLANT, quantity: 2, sku: "SYN-V1", name: "Implant", adjust: { kind: "net", value: "2723.45" } },
      { variant_id: ABUTMENT, quantity: 1, sku: "SYN-V2", name: "Abutment", bonus: true },
    ]);
  });
  it("the invoice discount comes back as typed", () => {
    expect(invoiceDiscountOf({ invoice_discount_amount: "100.00", invoice_discount_pct: null })).toEqual({ kind: "amount", value: "100" });
    expect(invoiceDiscountOf({ invoice_discount_amount: null, invoice_discount_pct: 5 })).toEqual({ kind: "pct", value: "5" });
    expect(invoiceDiscountOf({ invoice_discount_amount: null, invoice_discount_pct: null })).toBeNull();
  });
  it("the same product can be a paid line and a free line", () => {
    const one = addLine<{ variant_id: string; quantity: number; bonus?: boolean }>([], { variant_id: ABUTMENT, quantity: 1 });
    const two = addLine(one, { variant_id: ABUTMENT, quantity: 2, bonus: true });
    expect(two).toHaveLength(2);
    expect(addLine(two, { variant_id: ABUTMENT, quantity: 1, bonus: true })[1]!.quantity).toBe(3);
  });
});

describe("device copy keeps offers and what was typed", () => {
  function memory(): KeyValueStorage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
  }
  it("round trip; anything else is dropped", () => {
    const store = memory();
    const draft: LocalDraft = {
      slot: NEW_SLOT,
      orderId: null,
      serverVersion: 0,
      customerId: CUSTOMER,
      visitId: null,
      notes: "",
      lines: [{ variant_id: IMPLANT, quantity: 2, sku: "SYN-V1", name: "Implant", adjust: { kind: "net", value: "2723.45" } }],
      offers: [{ offer_id: OFFER, packages: 2, code: "PKG-3", name: "Package" }],
      invoiceDiscount: { kind: "pct", value: "5" },
      dirty: true,
      updatedAt: new Date(0).toISOString(),
    };
    expect(saveLocalDraft("user-a", draft, store)).toBe(true);
    expect(loadDraft("user-a", NEW_SLOT, store)).toEqual(draft);

    const key = "honest.orders.v1:user-a";
    const raw = JSON.parse(store.getItem(key)!) as Record<string, Record<string, unknown>>;
    raw[NEW_SLOT]!.lines = [{ variant_id: IMPLANT, quantity: 1, sku: "x", name: "x", list_price: 1, adjust: { kind: "price", value: "1" } }];
    raw[NEW_SLOT]!.invoiceDiscount = { kind: "total", value: "1" };
    raw[NEW_SLOT]!.offers = [{ offer_id: "not-a-uuid", packages: 1 }];
    store.setItem(key, JSON.stringify(raw));
    const back = loadDraft("user-a", NEW_SLOT, store)!;
    expect(back.lines).toEqual([{ variant_id: IMPLANT, quantity: 1, sku: "x", name: "x" }]);
    expect(back.invoiceDiscount).toBeNull();
    expect(back.offers).toEqual([]);
  });
  it("a copy saved before offers existed still loads", () => {
    const store = memory();
    store.setItem(
      "honest.orders.v1:user-a",
      JSON.stringify({ new: { slot: "new", orderId: null, serverVersion: 0, customerId: CUSTOMER, visitId: null, notes: "", lines: [{ variant_id: IMPLANT, quantity: 1, sku: "", name: "" }], dirty: true, updatedAt: new Date(0).toISOString() } }),
    );
    const back = loadDraft("user-a", NEW_SLOT, store)!;
    expect(back.offers).toEqual([]);
    expect(back.invoiceDiscount).toBeNull();
  });
});

describe("VAT and approval display", () => {
  it("prices are before VAT; VAT per rate leaves free lines out", () => {
    expect(PRICES_INCLUDE_VAT).toBe(false);
    expect(
      vatGroups([
        { tax_rate_pct: 14, line_subtotal: 1000, line_discount: 0, line_tax: 140 },
        { tax_rate_pct: "0.00", line_subtotal: "1000.00", line_discount: "0.00", line_tax: "0.00" },
        { tax_rate_pct: 14, line_subtotal: 0, line_discount: 0, line_tax: 0, is_bonus: true },
      ]),
    ).toEqual([
      { rate: 14, taxable: 1000, vat: 140 },
      { rate: 0, taxable: 1000, vat: 0 },
    ]);
  });
  it("the free-item reason is read from the history", () => {
    expect(approvalReasons([{ id: 1, to_status: "pending_approval", reason: "discount above limit; free item outside an offer; credit limit" }])).toEqual([
      "discount",
      "freeItem",
      "credit",
    ]);
  });
  it("offer and pricing errors keep their own codes", () => {
    for (const code of ["OFFER_EXPIRED", "OFFER_NOT_ELIGIBLE", "OFFER_CHANGED", "OFFER_INACTIVE", "NET_PRICE_ABOVE_LIST", "INVOICE_DISCOUNT_TOO_LARGE"]) {
      expect(orderErrorCode({ code, messageKey: "UNKNOWN", detail: "" })).toBe(code);
    }
  });
});
