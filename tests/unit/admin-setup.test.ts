import { afterEach, describe, expect, it } from "vitest";
import { geocodeAddress, insideEgypt } from "@/lib/maps/geocode";
import {
  IMPORT_SEQUENCE,
  mansouraNeedingCoverage,
  parseLatLngPair,
  SALES_MANAGER_ROLE,
  setupRoles,
  setupSteps,
  signInLinkUrl,
  type SetupOverview,
} from "@/modules/admin/setup";
import { baseLocationSchema, createWarehouseSchema, issueLoginSchema } from "@/modules/admin/setup-schemas";
import type { CoverageRow, RoleRow, TerritoryRow } from "@/modules/admin/types";
import setupAr from "../../messages/ar/setup.json";
import setupEn from "../../messages/en/setup.json";

const EMPLOYEE = "20000000-0000-0000-0000-000000000004";

const overview = (over: Partial<SetupOverview> = {}): SetupOverview => ({
  main_warehouses: 0, warehouses: 0, territories: 5, territories_with_coverage: 0, employees: 1, employees_with_login: 1,
  roles: { owner: 1 }, reps: 0, reps_with_base_location: 0, customers: 0, customers_phone_missing: 0, variants: 0,
  default_list_prices: 0, stock_units: 0, opening_ar_entries: 0, legacy_catalog_missing: ["GENERIC", "IMPLANT_PARTS", "STEP"],
  imports_committed: {}, ...over,
});

const role = (code: string, extra: Partial<RoleRow> = {}): RoleRow => ({
  id: `r-${code}`, code, name_en: code, name_ar: null, description: null, is_system: true, is_owner_role: code === "owner",
  is_active: true, permission_count: 1, ...extra,
});

describe("setup checklist", () => {
  it("a fresh company has everything to do except the owner's own login", () => {
    const steps = setupSteps(overview());
    expect(steps.map((s) => s.key)).toEqual([
      "warehouse", "territories", "people", "logins", "baseLocations", "catalog", "products", "prices", "stock", "customers", "openingAr",
    ]);
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual(["logins"]);
  });

  it("ticks steps off from the overview counts", () => {
    const steps = setupSteps(overview({
      main_warehouses: 1, territories_with_coverage: 1, employees: 4, employees_with_login: 3, reps: 2, reps_with_base_location: 2,
      variants: 515, default_list_prices: 501, legacy_catalog_missing: [], imports_committed: { products: 1, opening_stock: 1, customers: 1, opening_ar: 1 },
    }));
    const done = Object.fromEntries(steps.map((s) => [s.key, s.done]));
    expect(done).toMatchObject({ catalog: true, warehouse: true, territories: true, people: true, logins: false, baseLocations: true, prices: true, stock: true, customers: true, openingAr: true });
    expect(steps.find((s) => s.key === "logins")).toMatchObject({ count: 3, total: 4 });
    expect(steps.find((s) => s.key === "prices")?.href).toBe("/imports?kind=customer_prices");
  });

  it("lists the converter's files in upload order", () => {
    expect(IMPORT_SEQUENCE.map((s) => s.file)).toEqual([
      "1-products.csv", "2-base-prices.csv", "3-opening-stock.csv", "4-customers.csv", "5-opening-ar.csv", "6-opening-ar-credits.csv",
    ]);
    for (const s of IMPORT_SEQUENCE) {
      expect(typeof (setupEn.imports.files as Record<string, string>)[s.key]).toBe("string");
      expect(typeof (setupAr.imports.files as Record<string, string>)[s.key]).toBe("string");
    }
  });
});

describe("roles and territories", () => {
  it("offers setup roles in order, never the owner role; the sales manager is sales_director (decision B)", () => {
    const roles = [role("owner"), role("admin"), role("finance_officer"), role("sales_rep"), role("sales_director"), role("marketing_director"),
      role("area_manager", { is_active: false })];
    expect(setupRoles(roles).map((r) => r.code)).toEqual(["sales_rep", "sales_director", "finance_officer", "admin"]);
    expect(SALES_MANAGER_ROLE).toBe("sales_director");
  });

  it("offers Mansoura → Dakahlia coverage only while it is missing", () => {
    const mansoura: TerritoryRow = { id: "t1", code: "MANSOURA", name_en: "Mansoura", name_ar: "المنصورة", parent_id: null, level: "region", is_active: true };
    const cov = (gov: string, city = "*"): CoverageRow => ({
      territory_id: "t1", territory_code: "MANSOURA", territory_name_en: "Mansoura", territory_name_ar: null, territory_active: true,
      governorate_code: gov, governorate_name_en: gov, governorate_name_ar: gov, city,
    });
    expect(mansouraNeedingCoverage([mansoura], [])).toBe(mansoura);
    expect(mansouraNeedingCoverage([mansoura], [cov("EG-DK", "Talkha")])).toBe(mansoura);
    expect(mansouraNeedingCoverage([mansoura], [cov("EG-DK")])).toBeNull();
    expect(mansouraNeedingCoverage([{ ...mansoura, is_active: false }], [])).toBeNull();
  });
});

describe("sign-in links", () => {
  it("point at our own confirm route with the token hash", () => {
    const url = new URL(signInLinkUrl("https://staging.example.test", "ar", "abc123", "invite"));
    expect(url.origin + url.pathname).toBe("https://staging.example.test/ar/auth/confirm");
    expect(Object.fromEntries(url.searchParams)).toEqual({ token_hash: "abc123", type: "invite" });
    expect(new URL(signInLinkUrl("https://staging.example.test/", "en", "x", "magiclink")).pathname).toBe("/en/auth/confirm");
  });
});

describe("setup schemas", () => {
  it("warehouse: client id, upper-cased code", () => {
    expect(createWarehouseSchema.parse({ warehouse_id: "60000000-0000-0000-0000-0000000000a2", code: " wh-main ", name: "Main" }).code).toBe("WH-MAIN");
    expect(createWarehouseSchema.safeParse({ warehouse_id: "x", code: "WH", name: "Main" }).success).toBe(false);
    expect(createWarehouseSchema.safeParse({ warehouse_id: "60000000-0000-0000-0000-0000000000a2", code: "WH 1", name: "Main" }).success).toBe(false);
  });

  it("base location: address or a whole point inside Egypt; Arabic digits accepted", () => {
    expect(baseLocationSchema.parse({ employee_id: EMPLOYEE, address: "1 Synthetic Street" })).toEqual({ employee_id: EMPLOYEE, address: "1 Synthetic Street", intent: "save" });
    expect(baseLocationSchema.parse({ employee_id: EMPLOYEE, lat: "٣١٫٠٤", lng: "31.38" })).toMatchObject({ lat: 31.04, lng: 31.38 });
    expect(baseLocationSchema.safeParse({ employee_id: EMPLOYEE, lat: "31.04" }).success).toBe(false);
    expect(baseLocationSchema.safeParse({ employee_id: EMPLOYEE, lat: "48.85", lng: "2.35" }).success).toBe(false);
    expect(baseLocationSchema.safeParse({ employee_id: EMPLOYEE }).success).toBe(false);
    expect(baseLocationSchema.safeParse({ employee_id: EMPLOYEE, intent: "clear" }).success).toBe(true);
    expect(baseLocationSchema.safeParse({ employee_id: EMPLOYEE, address: "x y z", lead_radius_km: "80" }).success).toBe(false);
  });

  it("login: role and territory optional, invitee language required", () => {
    expect(issueLoginSchema.safeParse({ employee_id: EMPLOYEE, locale: "ar" }).success).toBe(true);
    expect(issueLoginSchema.safeParse({ employee_id: EMPLOYEE, locale: "fr" }).success).toBe(false);
    expect(issueLoginSchema.safeParse({ employee_id: EMPLOYEE, locale: "ar", role_id: "owner" }).success).toBe(false);
  });

  it("pasted map coordinates", () => {
    expect(parseLatLngPair("31.0409, 31.3785")).toEqual({ lat: 31.0409, lng: 31.3785 });
    expect(parseLatLngPair(" 31.0409 31.3785 ")).toEqual({ lat: 31.0409, lng: 31.3785 });
    expect(parseLatLngPair("31.0409،31.3785")).toEqual({ lat: 31.0409, lng: 31.3785 });
    expect(parseLatLngPair("Mansoura")).toBeNull();
  });
});

describe("geocodeAddress (server key, region eg, Arabic)", () => {
  const saved = process.env.GOOGLE_MAPS_SERVER_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
    else process.env.GOOGLE_MAPS_SERVER_KEY = saved;
  });

  const fakeFetch = (body: unknown, status = 200) => {
    const calls: URL[] = [];
    const fn = (async (input: URL | RequestInfo) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { fn, calls };
  };

  it("answers not_configured without a key, and never calls Google", async () => {
    delete process.env.GOOGLE_MAPS_SERVER_KEY;
    const { fn, calls } = fakeFetch({});
    expect(await geocodeAddress("1 Synthetic Street, Mansoura", { fetchImpl: fn })).toEqual({ status: "not_configured" });
    process.env.GOOGLE_MAPS_SERVER_KEY = "";
    expect(await geocodeAddress("1 Synthetic Street, Mansoura", { fetchImpl: fn })).toEqual({ status: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("asks Google with region eg, country EG and Arabic, and rounds the point", async () => {
    const { fn, calls } = fakeFetch({
      status: "OK",
      results: [{ formatted_address: "Synthetic, Mansoura", geometry: { location: { lat: 31.04091234, lng: 31.37854321 }, location_type: "ROOFTOP" } }],
    });
    const result = await geocodeAddress("1 Synthetic Street", { key: "k".repeat(39), fetchImpl: fn });
    expect(result).toEqual({ status: "ok", lat: 31.040912, lng: 31.378543, formattedAddress: "Synthetic, Mansoura", approximate: false });
    const q = calls[0]?.searchParams;
    expect([calls[0]?.host, q?.get("region"), q?.get("components"), q?.get("language"), q?.get("address")]).toEqual([
      "maps.googleapis.com", "eg", "country:EG", "ar", "1 Synthetic Street",
    ]);
  });

  it("maps Google's answers to not_found / outside_egypt / error", async () => {
    const key = "k".repeat(39);
    expect(await geocodeAddress("Nowhere 1", { key, fetchImpl: fakeFetch({ status: "ZERO_RESULTS", results: [] }).fn })).toEqual({ status: "not_found" });
    expect(await geocodeAddress("Paris 1", {
      key, fetchImpl: fakeFetch({ status: "OK", results: [{ geometry: { location: { lat: 48.85, lng: 2.35 } } }] }).fn,
    })).toEqual({ status: "outside_egypt" });
    expect(await geocodeAddress("Denied 1", { key, fetchImpl: fakeFetch({ status: "REQUEST_DENIED" }).fn })).toEqual({ status: "error", reason: "request_denied" });
    expect(await geocodeAddress("Down 1", { key, fetchImpl: fakeFetch({}, 503).fn })).toEqual({ status: "error", reason: "http_503" });
    const throwing = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await geocodeAddress("Offline 1", { key, fetchImpl: throwing })).toEqual({ status: "error", reason: "network" });
  });

  it("flags approximate matches; Egypt bounds match the database checks", async () => {
    const { fn } = fakeFetch({ status: "OK", results: [{ partial_match: true, geometry: { location: { lat: 31, lng: 31 } } }] });
    expect(await geocodeAddress("Somewhere 1", { key: "k".repeat(39), fetchImpl: fn })).toMatchObject({ status: "ok", approximate: true });
    expect(insideEgypt(21.5, 24.5) && insideEgypt(32, 37.5)).toBe(true);
    expect(insideEgypt(32.01, 31) || insideEgypt(31, 24.49)).toBe(false);
  });
});
