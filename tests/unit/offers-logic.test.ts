import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type Grant, type UserContext } from "@/lib/authz/can";
import { cairoToday, canManageOffers, canReadOffers, canSetVat, itemsPayload, offerErrorCode, offerState, parseCustomerNos, parseTags } from "@/modules/offers/logic";
import { offersNav } from "@/modules/offers/nav";
import { offerInputSchema } from "@/modules/offers/schemas";
import { vatRateSchema } from "@/modules/catalog/schemas";

const V1 = "56200000-0000-0000-0000-000000000001";
const V2 = "56200000-0000-0000-0000-000000000002";
type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/orders.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);
const ctx = (codes: string[], owner = false): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: "00000000-0000-0000-0000-0000000000a4",
  active: true,
  is_owner: owner,
  status: "active",
  permissions: Object.fromEntries(codes.map((c): [string, Grant] => [c, { scope: "all", limit: null }])),
});

describe("who sees and manages offers", () => {
  it("sellers read, the owner (or a sales.offer.manage holder) manages, only the owner sets VAT", () => {
    expect(canReadOffers(ctx(["sales.order.create"]))).toBe(true);
    expect(canReadOffers(ctx([]))).toBe(false);
    expect(canManageOffers(ctx(["sales.order.create"]))).toBe(false);
    expect(canManageOffers(ctx([], true))).toBe(true);
    expect(canSetVat(ctx(["catalog.product.manage"]))).toBe(false);
    expect(canSetVat(ctx([], true))).toBe(true);
  });
});

describe("offer state on a Cairo day", () => {
  const o = { is_active: true, valid_from: "2026-11-01", valid_to: "2026-11-30" };
  it.each([
    ["2026-10-31", "scheduled"],
    ["2026-11-01", "active"],
    ["2026-11-30", "active"],
    ["2026-12-01", "expired"],
  ])("%s → %s", (day, state) => expect(offerState(o, day)).toBe(state));
  it("switched off wins; no end date never expires", () => {
    expect(offerState({ ...o, is_active: false }, "2026-11-10")).toBe("inactive");
    expect(offerState({ ...o, valid_to: null }, "2099-01-01")).toBe("active");
    expect(cairoToday(new Date("2026-11-24T23:30:00Z"))).toBe("2026-11-25");
  });
});

describe("offer form input", () => {
  it("tags and customer numbers", () => {
    expect(parseTags("tier:gold, vip ،tier:gold")).toEqual(["tier:gold", "vip"]);
    expect(parseTags(Array.from({ length: 21 }, (_, i) => `t${i}`).join(","))).toBeNull();
    expect(parseCustomerNos("C-0001, C-0002 C-0001")).toEqual(["C-0001", "C-0002"]);
  });
  it("items for a package: no prices; paid lines required; one row per product and flag", () => {
    const paid = { variant_id: V1, sku: "S1", name: "Implant", quantity: "3", is_bonus: false, net_unit_price: "" };
    const free = { variant_id: V2, sku: "S2", name: "Abutment", quantity: "3", is_bonus: true, net_unit_price: "" };
    expect(itemsPayload([paid, free], "package")).toEqual([
      { variant_id: V1, quantity: 3 },
      { variant_id: V2, quantity: 3, is_bonus: true },
    ]);
    expect(itemsPayload([free], "package")).toBeNull();
    expect(itemsPayload([paid, paid], "package")).toBeNull();
    expect(itemsPayload([{ ...paid, quantity: "1.5" }], "package")).toBeNull();
  });
  it("items for per-line pricing need a net price on every paid line", () => {
    const paid = { variant_id: V1, sku: "S1", name: "Implant", quantity: "1", is_bonus: false, net_unit_price: "2668" };
    expect(itemsPayload([paid], "per_line")).toEqual([{ variant_id: V1, quantity: 1, net_unit_price: 2668 }]);
    expect(itemsPayload([{ ...paid, net_unit_price: "" }], "per_line")).toBeNull();
  });
  it("the action schema is strict", () => {
    const base = {
      offer_id: "56300000-0000-0000-0000-000000000001",
      code: "PKG-3",
      name_en: "Three implants",
      name_ar: null,
      description: null,
      pricing_mode: "package",
      package_price: 12000,
      valid_from: "2026-11-24",
      valid_to: null,
      items: [{ variant_id: V1, quantity: 3 }],
      customer_nos: [],
      target_tags: [],
      expected_version: null,
    };
    expect(offerInputSchema.safeParse(base).success).toBe(true);
    expect(offerInputSchema.safeParse({ ...base, total: 1 }).success).toBe(false);
    expect(offerInputSchema.safeParse({ ...base, items: [{ variant_id: V1, quantity: 3, list_price: 1 }] }).success).toBe(false);
    expect(offerInputSchema.safeParse({ ...base, package_price: 12000.001 }).success).toBe(false);
  });
  it("VAT rate input: 0–100, 2 decimals, 0 allowed", () => {
    const p = "56100000-0000-0000-0000-000000000005";
    expect(vatRateSchema.safeParse({ product_id: p, vat_rate_pct: "0" }).success).toBe(true);
    expect(vatRateSchema.safeParse({ product_id: p, vat_rate_pct: "14" }).success).toBe(true);
    expect(vatRateSchema.safeParse({ product_id: p, vat_rate_pct: "101" }).success).toBe(false);
    expect(vatRateSchema.safeParse({ product_id: p, vat_rate_pct: "14.001" }).success).toBe(false);
  });
  it("offer error codes", () => {
    expect(offerErrorCode({ code: "DUPLICATE_CODE", messageKey: "VALIDATION", detail: "" })).toBe("DUPLICATE_CODE");
    expect(offerErrorCode({ code: "OWNER_ONLY", messageKey: "PERMISSION_DENIED", detail: "" })).toBe("OWNER_ONLY");
    expect(offerErrorCode({ code: "OFFER_EXPIRED", messageKey: "UNKNOWN", detail: "" })).toBe("OFFER_EXPIRED");
  });
});

describe.each(["ar", "en"])("offer messages (%s)", (locale) => {
  const m = load(locale);
  it("nav, states, error codes and the bonus label exist", () => {
    for (const item of offersNav) expect(at(m, item.labelKey.replace(/^orders\./, "")), item.labelKey).toEqual(expect.any(String));
    for (const s of ["active", "scheduled", "expired", "inactive"]) expect(at(m, `offerAdmin.state.${s}`)).toEqual(expect.any(String));
    for (const c of ["DUPLICATE_CODE", "CUSTOMER_NOT_FOUND", "OWNER_ONLY"]) expect(at(m, `offerAdmin.errors.${c}`)).toEqual(expect.any(String));
    expect(at(m, "reasons.freeItem")).toEqual(expect.any(String));
    expect(at(m, "pricing.bonus")).toEqual(expect.any(String));
  });
});
