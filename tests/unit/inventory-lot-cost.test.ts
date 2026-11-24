import { describe, expect, it } from "vitest";
import ar from "../../messages/ar/inventory.json";
import en from "../../messages/en/inventory.json";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import { qualityHref } from "@/modules/imports/legacy/flow";
import { canSetLotCost, errorMessageRef, lotCostDisplay, lotCostsByLot, MAX_UNIT_COST, parseUnitCost } from "@/modules/inventory/logic";
import { lotCostInvalidField, setLotCostSchema } from "@/modules/inventory/schemas";
import { LOT_COST_STATUSES, type LotCostRow } from "@/modules/inventory/types";

/** The owner sets an unknown lot cost once (decision 2026-11-24; api.set_lot_cost, suite 63). */

const LOT = "61000000-0000-0000-0000-0000000000a1";
const VARIANT = "53000000-0000-0000-0000-0000000000a1";
const KEY = "63000000-0000-4000-8000-000000000001";

const ctx = (over: Partial<UserContext>): UserContext => ({ ...ANONYMOUS_CONTEXT, active: true, status: "active", ...over });
const owner = ctx({ is_owner: true });
const inventoryManager = ctx({ permissions: { "catalog.cost.read": { scope: "all", limit: null }, "inventory.stock.read": { scope: "all", limit: null } } });

const row = (over: Partial<LotCostRow>): LotCostRow => ({
  lot_id: LOT,
  variant_id: VARIANT,
  lot_no: "LC1-A",
  cost_status: "unknown",
  unit_cost: null,
  cost_set_at: null,
  ...over,
});

describe("parseUnitCost", () => {
  it.each([
    ["1250", 1250],
    ["1250.5", 1250.5],
    ["1250.50", 1250.5],
    ["1,250.50", 1250.5],
    [" 0.01 ", 0.01],
    ["١٢٥٠٫٥", 1250.5],
    ["۱۲۵۰", 1250],
    ["999999999999.99", MAX_UNIT_COST],
  ])("%s → %s", (raw, value) => {
    expect(parseUnitCost(raw)).toBe(value);
  });

  it.each(["", "0", "0.00", "-5", "10.555", "1e3", "abc", "1000000000000", "12.", ".5"])("refuses %j", (raw) => {
    expect(parseUnitCost(raw)).toBeNull();
  });

  it("refuses a missing value", () => {
    expect(parseUnitCost(null)).toBeNull();
    expect(parseUnitCost(undefined)).toBeNull();
  });
});

describe("setLotCostSchema", () => {
  const valid = { lot_id: LOT, variant_id: VARIANT, unit_cost: "1234.50", reason: "  Supplier invoice  ", idempotency_key: KEY };

  it("accepts a cost over 0 with two decimals and a 3–500 character reason (trimmed)", () => {
    const parsed = setLotCostSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, unit_cost: 1234.5, reason: "Supplier invoice" });
  });

  it.each([
    ["a cost of 0", { unit_cost: "0" }, "unit_cost"],
    ["a negative cost", { unit_cost: "-1" }, "unit_cost"],
    ["three decimals", { unit_cost: "1.234" }, "unit_cost"],
    ["a missing cost", { unit_cost: undefined }, "unit_cost"],
    ["a short reason", { reason: " ab " }, "reason"],
    ["a long reason", { reason: "x".repeat(501) }, "reason"],
    ["a missing reason", { reason: undefined }, "reason"],
  ] as const)("refuses %s (field %s)", (_label, change, field) => {
    const result = setLotCostSchema.safeParse({ ...valid, ...change });
    expect(result.success).toBe(false);
    if (!result.success) expect(lotCostInvalidField(result.error)).toBe(field);
  });

  it("accepts exactly 3 and 500 characters", () => {
    expect(setLotCostSchema.safeParse({ ...valid, reason: "abc" }).success).toBe(true);
    expect(setLotCostSchema.safeParse({ ...valid, reason: "x".repeat(500) }).success).toBe(true);
  });

  it("needs a lot id, the SKU id and the page's key", () => {
    for (const k of ["lot_id", "variant_id", "idempotency_key"] as const) {
      const result = setLotCostSchema.safeParse({ ...valid, [k]: "not-an-id" });
      expect(result.success, k).toBe(false);
      if (!result.success) expect(lotCostInvalidField(result.error)).toBeUndefined();
    }
  });
});

describe("errors", () => {
  it("COST_ALREADY_SET has its own inventory text in both languages", () => {
    expect(errorMessageRef("COST_ALREADY_SET", "UNKNOWN")).toEqual({ namespace: "inventory.errors", key: "COST_ALREADY_SET" });
    expect(en.errors.COST_ALREADY_SET).toMatch(/never changed/);
    expect(ar.errors.COST_ALREADY_SET.length).toBeGreaterThan(10);
  });

  it("owner-only, MFA and the rest use the shared texts (MFA keeps the step-up link)", () => {
    expect(errorMessageRef("OWNER_ONLY", "OWNER_ONLY")).toEqual({ namespace: "errors", key: "OWNER_ONLY" });
    expect(errorMessageRef("MFA_REQUIRED", "MFA_REQUIRED")).toEqual({ namespace: "errors", key: "MFA_REQUIRED" });
    expect(errorMessageRef("CONFLICT", "CONFLICT")).toEqual({ namespace: "errors", key: "CONFLICT" });
    expect(errorMessageRef("VALIDATION", "VALIDATION")).toEqual({ namespace: "errors", key: "VALIDATION" });
  });
});

describe("lot cost display", () => {
  it("unknown shows no amount; known and set show theirs", () => {
    expect(lotCostDisplay(row({}))).toEqual({ status: "unknown", amount: null });
    expect(lotCostDisplay(row({ cost_status: "set", unit_cost: "1234.50" }))).toEqual({ status: "set", amount: 1234.5 });
    expect(lotCostDisplay(row({ cost_status: "known", unit_cost: 250 }))).toEqual({ status: "known", amount: 250 });
  });

  it("a lot without a row shows nothing (no cost reader, or never received)", () => {
    expect(lotCostDisplay(undefined)).toBeNull();
  });

  it("indexes rows by lot", () => {
    const map = lotCostsByLot([row({}), row({ lot_id: "61000000-0000-0000-0000-0000000000a2", lot_no: "LC1-B" })]);
    expect(map.get(LOT)?.lot_no).toBe("LC1-A");
    expect(map.size).toBe(2);
  });

  it("the cost texts exist in both languages with the same keys", () => {
    expect(Object.keys(ar.lotCost).sort()).toEqual(Object.keys(en.lotCost).sort());
    expect(en.lotCost.unknown).toBe("Cost unknown");
    expect(en.lotCost.open).toBe("Set cost");
    expect(typeof en.detail.unitCost).toBe("string");
    expect(typeof ar.detail.unitCost).toBe("string");
    expect(LOT_COST_STATUSES).toEqual(["unknown", "known", "set"]);
  });
});

describe("canSetLotCost (UI only; Postgres decides)", () => {
  it("the owner only", () => {
    expect(canSetLotCost(owner)).toBe(true);
    expect(canSetLotCost(inventoryManager)).toBe(false);
    expect(canSetLotCost(ctx({ permissions: { "inventory.lot.set_cost": { scope: "all", limit: null } } }))).toBe(false);
    expect(canSetLotCost({ ...owner, active: false })).toBe(false);
    expect(canSetLotCost(ANONYMOUS_CONTEXT)).toBe(false);
  });
});

describe("data to complete links", () => {
  const base = { entity_id: VARIANT, customer_id: null, product_id: "52000000-0000-0000-0000-0000000000a1" };

  it("an item without cost opens its stock-by-lot page (where the owner sets the cost)", () => {
    expect(qualityHref({ ...base, issue: "cost_unknown", entity_type: "product" })).toBe(`/inventory/stock/${VARIANT}`);
  });

  it("a customer row opens the customer", () => {
    const id = "40000000-0000-0000-0000-000000000001";
    expect(qualityHref({ issue: "phone_missing", entity_type: "customer", entity_id: id, customer_id: id, product_id: null })).toBe(`/customers/${id}`);
    expect(qualityHref({ issue: "location_missing", entity_type: "customer", entity_id: id, customer_id: id, product_id: null })).toBe(`/customers/${id}`);
  });
});
