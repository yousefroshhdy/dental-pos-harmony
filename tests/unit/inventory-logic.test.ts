import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  addDays,
  adjustmentLimit,
  brandOptions,
  cairoDayStartUtc,
  cairoToday,
  canReadReceipts,
  canReadTransfers,
  composeReason,
  daysBetween,
  errorMessageRef,
  expiryStatus,
  isSellableKind,
  lotsFefo,
  parseAdjustmentResult,
  parseMovementFilters,
  parseReason,
  parseStockFilters,
  parseStockLineValue,
  productOptions,
  receiptLineIssues,
  signedQuantity,
  stockLineValue,
  stockOverview,
  summarizeStock,
  toQuery,
  transferActions,
  variantIdsFor,
  warehouseKindTone,
} from "@/modules/inventory/logic";
import type { ReorderAlertRow, StockDetailRow, StockRow, VariantRow } from "@/modules/inventory/types";

const WH = "60000000-0000-0000-0000-000000000001";
const VAR = "53000000-0000-0000-0000-000000000001";
const LOT = "61000000-0000-0000-0000-000000000001";

function ctx(permissions: Record<string, { scope: "own" | "warehouse" | "all"; limit?: number | null }>, extra: Partial<UserContext> = {}): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: "11111111-1111-4111-8111-111111111111",
    active: true,
    status: "active",
    permissions: Object.fromEntries(Object.entries(permissions).map(([k, v]) => [k, { scope: v.scope, limit: v.limit ?? null }])),
    ...extra,
  };
}

function stock(p: Partial<StockRow>): StockRow {
  return {
    warehouse_id: WH,
    warehouse_code: "WH-CAI",
    warehouse_name: "Cairo",
    warehouse_kind: "main",
    is_sellable: true,
    variant_id: VAR,
    sku: "BIO-TOP-4110",
    variant_name: "Top 4.1x10",
    product_id: "p1",
    product_name: "Bioner Top",
    brand_id: "b1",
    brand_code: "BIONER",
    brand_name: "Bioner",
    reorder_point: 0,
    on_hand: 10,
    reserved: 0,
    available: 10,
    sellable_available: 10,
    expired_qty: 0,
    near_expiry_qty: 0,
    earliest_expiry: null,
    days_to_earliest_expiry: null,
    lot_count: 1,
    ...p,
  };
}

const alert = (variant_id: string): ReorderAlertRow => ({
  variant_id,
  sku: "S",
  variant_name: "V",
  product_id: "p1",
  product_name: "P",
  brand_id: "b1",
  brand_code: "B",
  brand_name: "B",
  reorder_point: 20,
  sellable_available: 13,
  shortfall: 7,
});

describe("warehouse kinds", () => {
  it("quarantine and transit are never sellable", () => {
    expect(isSellableKind("main")).toBe(true);
    expect(isSellableKind("branch")).toBe(true);
    expect(isSellableKind("rep_stock")).toBe(true);
    expect(isSellableKind("quarantine")).toBe(false);
    expect(isSellableKind("transit")).toBe(false);
    expect(isSellableKind(null)).toBe(false);
    expect(warehouseKindTone("quarantine")).toBe("danger");
    expect(warehouseKindTone("transit")).toBe("warning");
  });
});

describe("expiry", () => {
  it.each([
    [null, "none"],
    [-1, "expired"],
    [0, "critical"],
    [29, "critical"],
    [30, "near"],
    [89, "near"],
    [90, "ok"],
  ] as const)("%s days → %s", (days, status) => {
    expect(expiryStatus(days)).toBe(status);
  });

  it("Cairo calendar helpers", () => {
    // 22:30 UTC on 31 Dec is already 1 Jan in Cairo (UTC+2 in winter).
    expect(cairoToday(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
    expect(daysBetween("2026-10-29", "2026-11-28")).toBe(30);
    expect(daysBetween("2026-10-29", "2026-10-19")).toBe(-10);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("Cairo day boundaries follow DST", () => {
    expect(cairoDayStartUtc("2026-01-15")).toBe("2026-01-14T22:00:00.000Z"); // winter, UTC+2
    expect(cairoDayStartUtc("2026-07-15")).toBe("2026-07-14T21:00:00.000Z"); // summer, UTC+3
  });
});

describe("stock overview", () => {
  const rows = [
    stock({ variant_id: "v2", sku: "B", product_name: "Zeta" }),
    stock({ sku: "A", product_name: "Alpha", near_expiry_qty: 4, expired_qty: 2 }),
    stock({ sku: "A", product_name: "Alpha", warehouse_code: "WH-QUA", warehouse_kind: "quarantine", is_sellable: false, on_hand: 3, sellable_available: 0 }),
  ];

  it("flags below-reorder (sellable rows only), near-expiry, expired and not-sellable", () => {
    const out = stockOverview(rows, [alert(VAR)], "all");
    expect(out.map((o) => `${o.row.sku}/${o.row.warehouse_code}`)).toEqual(["A/WH-CAI", "A/WH-QUA", "B/WH-CAI"]);
    expect(out[0]?.flags).toEqual({ belowReorder: true, nearExpiry: true, expired: true, notSellable: false });
    expect(out[1]?.flags).toEqual({ belowReorder: false, nearExpiry: false, expired: false, notSellable: true });
  });

  it.each([
    ["below_reorder", ["A/WH-CAI"]],
    ["near_expiry", ["A/WH-CAI"]],
    ["expired", ["A/WH-CAI"]],
    ["not_sellable", ["A/WH-QUA"]],
  ] as const)("alert filter %s", (filter, expected) => {
    expect(stockOverview(rows, [alert(VAR)], filter).map((o) => `${o.row.sku}/${o.row.warehouse_code}`)).toEqual(expected);
  });

  it("summarises alerts", () => {
    expect(summarizeStock(rows, [alert(VAR)])).toEqual({ belowReorder: 1, nearExpiryLines: 1, expiredQty: 2, notSellableQty: 3 });
  });

  it("lots in FEFO order, empty balances hidden unless asked", () => {
    const lot = (p: Partial<StockDetailRow>): StockDetailRow => ({
      warehouse_id: WH,
      warehouse_code: "WH-CAI",
      variant_id: VAR,
      sku: "A",
      lot_id: LOT,
      lot_no: "L",
      expiry_date: null,
      days_to_expiry: null,
      on_hand: 1,
      reserved: 0,
      available: 1,
      updated_at: "",
      ...p,
    });
    const rows = [lot({ lot_no: "N" }), lot({ lot_no: "B", expiry_date: "2027-01-01" }), lot({ lot_no: "A", expiry_date: "2026-12-01" }), lot({ lot_no: "Z", on_hand: 0, available: 0 })];
    expect(lotsFefo(rows).map((r) => r.lot_no)).toEqual(["A", "B", "N"]);
    expect(lotsFefo(rows, { keepEmpty: true }).map((r) => r.lot_no)).toEqual(["A", "B", "N", "Z"]);
  });
});

describe("catalogue filters", () => {
  const v = (p: Partial<VariantRow>): VariantRow => ({
    variant_id: VAR,
    sku: "S",
    variant_name: "V",
    uom: "unit",
    reorder_point: 0,
    variant_status: "active",
    product_id: "p1",
    product_code: "P1",
    product_name: "Implant",
    product_name_ar: "زرعة",
    product_status: "active",
    is_lot_tracked: true,
    is_expiry_tracked: false,
    brand_id: "b1",
    brand_code: "BIONER",
    brand_name: "Bioner",
    ...p,
  });
  const variants = [v({}), v({ variant_id: "v2", product_id: "p2", product_name: "Mirror", product_name_ar: null, brand_id: "b2", brand_name: "Derby" })];

  it("brand and product options, localized and narrowed by brand", () => {
    expect(brandOptions(variants)).toEqual([
      { value: "b1", label: "Bioner" },
      { value: "b2", label: "Derby" },
    ]);
    expect(productOptions(variants, "ar")).toEqual([
      { value: "p2", label: "Mirror" },
      { value: "p1", label: "زرعة" },
    ]);
    expect(productOptions(variants, "en", "b2")).toEqual([{ value: "p2", label: "Mirror" }]);
    expect(variantIdsFor(variants, { brand: "b2" })).toEqual(["v2"]);
    expect(variantIdsFor(variants, { brand: "b1", product: "p2" })).toEqual([]);
  });
});

describe("search-param filters", () => {
  it("keeps only valid ids and enum values", () => {
    expect(parseStockFilters({ warehouse: WH, brand: "nope", alert: "expired" })).toEqual({ warehouse: WH, brand: undefined, product: undefined, alert: "expired" });
    expect(parseStockFilters({ alert: "drop table" }).alert).toBe("all");
  });

  it("movement filters validate dates, types and the keyset cursor", () => {
    const f = parseMovementFilters({
      type: "receipt",
      from: "2026-10-01",
      to: "not-a-date",
      source_type: "receipt",
      source_id: WH,
      before: "2026-10-29T13:17:15.555123+00:00",
      before_id: LOT,
    });
    expect(f).toMatchObject({ type: "receipt", from: "2026-10-01", to: undefined, sourceType: "receipt", sourceId: WH, before: "2026-10-29T13:17:15.555123+00:00", beforeId: LOT });
    expect(parseMovementFilters({ before: "2026-10-29T13:17:15Z" }).before).toBeUndefined(); // cursor needs both parts
    expect(parseMovementFilters({ before: "x),or(id.gt.0", before_id: LOT }).before).toBeUndefined();
    expect(parseMovementFilters({ type: "edit" }).type).toBeUndefined();
  });

  it("toQuery drops empty values", () => {
    expect(toQuery({ a: "1", b: undefined, c: "" })).toBe("?a=1");
    expect(toQuery({})).toBe("");
  });
});

describe("adjustments", () => {
  it("reason codes round-trip with an optional note", () => {
    expect(composeReason("damaged")).toBe("damaged");
    expect(composeReason("other", "  water leak ")).toBe("other: water leak");
    expect(parseReason("other: water leak")).toEqual({ code: "other", note: "water leak" });
    expect(parseReason("damaged")).toEqual({ code: "damaged", note: null });
    expect(parseReason("damaged in storage")).toEqual({ code: null, note: "damaged in storage" });
    expect(parseReason(null)).toEqual({ code: null, note: null });
  });

  it("direction carries the sign", () => {
    expect(signedQuantity("out", 3)).toBe(-3);
    expect(signedQuantity("in", 3)).toBe(3);
  });

  it("stock line values round-trip and reject junk", () => {
    expect(parseStockLineValue(stockLineValue(VAR, LOT))).toEqual({ variantId: VAR, lotId: LOT });
    expect(parseStockLineValue(`${VAR}:${LOT}:x`)).toBeNull();
    expect(parseStockLineValue("a:b")).toBeNull();
  });

  it("normalises the command result: posted or pending approval (audit #3)", () => {
    expect(parseAdjustmentResult({ status: "posted", movement_id: "m1", approval_request_id: null, replayed: false })).toEqual({
      outcome: "posted",
      movementId: "m1",
      approvalRequestId: null,
      replayed: false,
    });
    expect(parseAdjustmentResult({ status: "pending_approval", approval_request_id: "r1", movement_id: null, replayed: true })).toEqual({
      outcome: "pending_approval",
      movementId: null,
      approvalRequestId: "r1",
      replayed: true,
    });
    expect(parseAdjustmentResult(null).outcome).toBe("pending_approval");
  });

  it("limit from the user's grant", () => {
    expect(adjustmentLimit(ctx({ "inventory.adjustment.post": { scope: "all", limit: 5 } }))).toBe(5);
    expect(adjustmentLimit(ctx({ "inventory.adjustment.post": { scope: "all", limit: null } }))).toBeNull();
    expect(adjustmentLimit(ctx({}))).toBeUndefined();
    expect(adjustmentLimit(ctx({}, { is_owner: true }))).toBeNull();
  });
});

describe("receipts", () => {
  it("warns before the database refuses", () => {
    const today = "2026-10-29";
    expect(receiptLineIssues({ expiry_date: null }, { expiryTracked: true, warehouseKind: "main", today })).toEqual(["EXPIRY_REQUIRED"]);
    expect(receiptLineIssues({ expiry_date: "2026-10-01" }, { expiryTracked: false, warehouseKind: "main", today })).toEqual(["EXPIRED_NEEDS_QUARANTINE"]);
    expect(receiptLineIssues({ expiry_date: "2026-10-01" }, { expiryTracked: true, warehouseKind: "quarantine", today })).toEqual([]);
    expect(receiptLineIssues({ expiry_date: "2026-10-29" }, { expiryTracked: true, warehouseKind: "main", today })).toEqual([]);
  });
});

describe("permissions (UX only)", () => {
  it("transfer actions follow status and permission", () => {
    const shipper = ctx({ "inventory.transfer.create": { scope: "warehouse" } });
    const receiver = ctx({ "inventory.transfer.receive": { scope: "warehouse" } });
    expect(transferActions(shipper, { status: "draft" })).toEqual({ ship: true, receive: false });
    expect(transferActions(shipper, { status: "in_transit" })).toEqual({ ship: false, receive: false });
    expect(transferActions(receiver, { status: "in_transit" })).toEqual({ ship: false, receive: true });
    expect(transferActions(receiver, { status: "received" })).toEqual({ ship: false, receive: false });
  });

  it("list pages open for any related permission", () => {
    expect(canReadTransfers(ctx({ "inventory.movement.read": { scope: "all" } }))).toBe(true);
    expect(canReadReceipts(ctx({ "inventory.receipt.post": { scope: "warehouse" } }))).toBe(true);
    expect(canReadReceipts(ctx({ "inventory.stock.read": { scope: "own" } }))).toBe(false);
  });
});

describe("errors", () => {
  it("inventory codes get inventory text; others fall back to errors.*", () => {
    expect(errorMessageRef("INSUFFICIENT_STOCK", "UNKNOWN")).toEqual({ namespace: "inventory.errors", key: "INSUFFICIENT_STOCK" });
    expect(errorMessageRef("PERMISSION_DENIED", "PERMISSION_DENIED")).toEqual({ namespace: "errors", key: "PERMISSION_DENIED" });
    expect(errorMessageRef("WEIRD", "NOT_A_KEY")).toEqual({ namespace: "errors", key: "UNKNOWN" });
  });
});
