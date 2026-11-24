import { describe, expect, it } from "vitest";
import {
  canEditPlan,
  groupUnrated,
  historyRules,
  isDayKey,
  liveRules,
  parseRatePct,
  planStatusTone,
  ruleStateTone,
  statementFunnel,
} from "@/modules/commissions/logic";
import { activatePlanSchema, createPlanSchema, deactivatePlanSchema, parsePlanId, rateSchema } from "@/modules/commissions/schemas";
import type { RuleRow, StatementTotalsRow, UnratedRow } from "@/modules/commissions/types";

const PLAN = "58000000-0000-0000-0000-000000000001";
const BRAND = "58000000-0000-0000-0000-000000000002";
const KEY = "58000000-0000-0000-0000-0000000000aa";

const rule = (over: Partial<RuleRow>): RuleRow => ({
  id: "r",
  plan_id: PLAN,
  plan_code: "STD-2026",
  target_type: "brand",
  target_id: BRAND,
  target_code: "BIONER",
  target_name_en: "Bioner",
  target_name_ar: "Bioner",
  rate_pct: "5.00",
  priority: 50,
  effective_from: null,
  effective_to: null,
  voided_at: null,
  note: null,
  created_at: "2026-11-25T08:00:00Z",
  state: "current",
  ...over,
});

describe("rate input", () => {
  it("takes 0–100 with at most 2 decimals, Arabic-Indic digits and a % sign", () => {
    expect(parseRatePct("5")).toBe(5);
    expect(parseRatePct("1.5")).toBe(1.5);
    expect(parseRatePct("0")).toBe(0);
    expect(parseRatePct("100")).toBe(100);
    expect(parseRatePct(" ١٫٥ ")).toBe(1.5);
    expect(parseRatePct("5 %")).toBe(5);
    expect(parseRatePct("٥٪")).toBe(5);
  });

  it("refuses negatives, more than 100, 3 decimals and text", () => {
    for (const bad of ["-1", "100.01", "101", "1.555", "", "abc", "5,5", "1e2"]) expect(parseRatePct(bad), bad).toBeNull();
  });

  it("days are real calendar days", () => {
    expect(isDayKey("2026-11-25")).toBe(true);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2026-02-29")).toBe(false);
    expect(isDayKey("2026-11")).toBe(false);
    expect(isDayKey("1999-12-31")).toBe(false);
  });
});

describe("rate editor schemas", () => {
  const valid = { plan_id: PLAN, target: "brand", target_id: BRAND, rate: "5", effective_from: "2026-11-25", idempotency_key: KEY };

  it("parses a brand rate", () => {
    const r = rateSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rate_pct).toBe(5);
  });

  it("the plan default takes no target; the others need one", () => {
    expect(rateSchema.safeParse({ ...valid, target: "default", target_id: undefined }).success).toBe(true);
    expect(rateSchema.safeParse({ ...valid, target: "default" }).success).toBe(false);
    expect(rateSchema.safeParse({ ...valid, target_id: undefined }).success).toBe(false);
    expect(rateSchema.safeParse({ ...valid, target: "shelf" }).success).toBe(false);
  });

  it("clearing a rate sends no rate (NULL: no rate from that day)", () => {
    const r = rateSchema.safeParse({ ...valid, rate: undefined, clear: "1" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rate_pct).toBeNull();
  });

  it("refuses a bad rate, a bad day and a missing key", () => {
    expect(rateSchema.safeParse({ ...valid, rate: "101" }).success).toBe(false);
    expect(rateSchema.safeParse({ ...valid, rate: undefined }).success).toBe(false);
    expect(rateSchema.safeParse({ ...valid, effective_from: "2026-13-01" }).success).toBe(false);
    expect(rateSchema.safeParse({ ...valid, idempotency_key: undefined }).success).toBe(false);
  });

  it("plan codes, activation and deactivation", () => {
    const c = createPlanSchema.safeParse({ code: "std-2027", name: "Standard 2027" });
    expect(c.success && c.data.code).toBe("STD-2027");
    expect(createPlanSchema.safeParse({ code: "-bad", name: "Standard" }).success).toBe(false);
    expect(createPlanSchema.safeParse({ code: "OK1", name: "ab" }).success).toBe(false);
    const a = activatePlanSchema.safeParse({ plan_id: PLAN, effective_from: "2026-11-25" });
    expect(a.success && a.data.assign_sales_reps).toBe("1");
    expect(deactivatePlanSchema.safeParse({ plan_id: PLAN, effective_to: "2026-11-30", reason: "ok" }).success).toBe(false);
    expect(deactivatePlanSchema.safeParse({ plan_id: PLAN, effective_to: "2026-11-30", reason: "Plan replaced" }).success).toBe(true);
    expect(parsePlanId(PLAN)).toBe(PLAN);
    expect(parsePlanId("x")).toBeNull();
  });
});

describe("rate lists", () => {
  it("live rates: most specific target first, history apart", () => {
    const rules = [
      rule({ id: "b", target_type: "brand", target_code: "RDT" }),
      rule({ id: "d", target_type: "default", target_code: null }),
      rule({ id: "v", target_type: "variant", target_code: "BIO-1", state: "scheduled", effective_from: "2026-12-01" }),
      rule({ id: "c", target_type: "category", target_code: "IMPLANT" }),
      rule({ id: "old", state: "ended", effective_from: "2026-01-01", effective_to: "2026-11-24" }),
      rule({ id: "void", state: "void", effective_from: "2026-12-01" }),
    ];
    expect(liveRules(rules).map((r) => r.id)).toEqual(["v", "c", "b", "d"]);
    expect(historyRules(rules).map((r) => r.id)).toEqual(["void", "old"]);
  });

  it("tones and editability", () => {
    expect(planStatusTone("active")).toBe("success");
    expect(planStatusTone("draft")).toBe("warning");
    expect(ruleStateTone("void")).toBe("danger");
    expect(canEditPlan("retired")).toBe(false);
    expect(canEditPlan("draft")).toBe(true);
  });

  it("the no-rate list is grouped by brand", () => {
    const row = (sku: string, brand: string): UnratedRow => ({
      variant_id: sku,
      sku,
      variant_name_en: sku,
      product_id: sku,
      product_code: sku,
      product_name_en: sku,
      product_name_ar: null,
      brand_id: `id-${brand}`,
      brand_code: brand,
      brand_name: brand,
      category_id: "c",
      category_code: "GRAFT",
      category_name_en: "Bone grafts",
      category_name_ar: "الطعوم العظمية",
    });
    const groups = groupUnrated([row("G-2", "STEP"), row("X-1", "CHINA"), row("G-1", "STEP")]);
    expect(groups.map((g) => [g.brandCode, g.brandId, g.items.length])).toEqual([
      ["CHINA", "id-CHINA", 1],
      ["STEP", "id-STEP", 2],
    ]);
  });
});

describe("rep statement steps", () => {
  it("collected → VAT out → commissionable → commission → clawbacks → net, from the server's figures", () => {
    const totals = {
      collected_gross: "2280.00",
      vat_amount: "280.00",
      commissionable: "2000.00",
      unrated_base: "1000.00",
      commission: "32.50",
      clawbacks: "-50.00",
      adjustments: "0.00",
      net: "-17.50",
    } as unknown as StatementTotalsRow;
    expect(statementFunnel(totals).map((s) => [s.key, s.value, s.detail])).toEqual([
      ["collected", 2280, false],
      ["vat", -280, true],
      ["commissionable", 2000, false],
      ["unrated", 1000, true],
      ["commission", 32.5, false],
      ["clawbacks", -50, false],
      ["adjustments", 0, false],
      ["net", -17.5, false],
    ]);
  });

  it("no row yet: all zeros", () => {
    expect(statementFunnel(null).every((s) => Object.is(s.value, 0))).toBe(true);
  });
});
