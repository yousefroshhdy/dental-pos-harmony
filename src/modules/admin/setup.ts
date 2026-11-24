import type { ImportKind } from "@/modules/imports/kinds";
import type { CoverageRow, RoleRow, TerritoryRow } from "./types";

/**
 * Owner setup screen (/admin/setup): pure helpers and row shapes. UI gating here is cosmetic;
 * every command re-checks permissions in Postgres (api.setup_overview is owner-only).
 */

/** api.setup_overview() (20261125000100_phase_p_setup.sql). Counts only. */
export interface SetupOverview {
  main_warehouses: number;
  warehouses: number;
  territories: number;
  territories_with_coverage: number;
  employees: number;
  employees_with_login: number;
  roles: Record<string, number>;
  reps: number;
  reps_with_base_location: number;
  customers: number;
  customers_phone_missing: number;
  variants: number;
  default_list_prices: number;
  stock_units: number;
  opening_ar_entries: number;
  /** Brand / category codes the legacy converter's products file needs that do not exist yet. */
  legacy_catalog_missing: string[];
  imports_committed: Record<string, number>;
}

/**
 * Brands and the category the old system's items need beyond the seeded ones (scripts/legacy/
 * convert.ts: STEP grafts and membranes, unbranded items, Bioner abutments/kits). Added by the
 * owner with api.create_brand / api.create_category, not seeded by a migration.
 */
export const LEGACY_BRANDS = [
  { code: "STEP", name: "STEP" },
  { code: "GENERIC", name: "Generic / unbranded" },
] as const;
export const LEGACY_CATEGORIES = [
  { code: "IMPLANT_PARTS", nameEn: "Implant components and kits", nameAr: "مكونات وأدوات الزرعات", parent: "IMPLANT" },
] as const;

/** api.v_employee_base_locations. */
export interface BaseLocationRow {
  employee_id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  job_title: string;
  employment_status: string;
  user_id: string | null;
  base_address: string | null;
  base_lat: number | null;
  base_lng: number | null;
  base_location_source: "geocoded" | "manual" | null;
  lead_radius_km: number;
  base_set_at: string | null;
}

/** api.v_inventory_warehouses. */
export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  is_active: boolean;
}

/**
 * Roles offered when a login is created on the setup screen, in this order. The owner role is
 * never offered here (owners are made on Users → role grants, with the owner safeguards).
 * Decision B's "sales manager" (manual discounts up to 25 %) is the seeded role `sales_director`.
 */
export const SETUP_ROLE_CODES = ["sales_rep", "sales_director", "area_manager", "finance_officer", "collection_officer", "inventory_manager", "admin"] as const;
export const SALES_MANAGER_ROLE = "sales_director";

export function setupRoles(roles: readonly RoleRow[]): RoleRow[] {
  const order = new Map<string, number>(SETUP_ROLE_CODES.map((c, i) => [c, i]));
  return roles
    .filter((r) => r.is_active && !r.is_owner_role && order.has(r.code))
    .sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
}

/** Mansoura is in Dakahlia (ISO 3166-2:EG EG-DK). The MANSOURA region is seeded reference data. */
export const MANSOURA = { territoryCode: "MANSOURA", governorateCode: "EG-DK" } as const;

/** The MANSOURA territory when it exists, is active and does not cover Dakahlia yet. */
export function mansouraNeedingCoverage(territories: readonly TerritoryRow[], coverage: readonly CoverageRow[]): TerritoryRow | null {
  const t = territories.find((x) => x.code === MANSOURA.territoryCode && x.is_active);
  if (!t) return null;
  const covered = coverage.some((c) => c.governorate_code === MANSOURA.governorateCode && c.city === "*");
  return covered ? null : t;
}

export type StepKey =
  | "warehouse"
  | "territories"
  | "people"
  | "logins"
  | "baseLocations"
  | "catalog"
  | "products"
  | "prices"
  | "stock"
  | "customers"
  | "openingAr";

export interface SetupStep {
  key: StepKey;
  done: boolean;
  /** Shown next to the step ("3 of 4 reps"). */
  count: number;
  total?: number;
  /** In-page anchor or app route. */
  href: string;
}

const importHref = (kind: ImportKind) => `/imports?kind=${kind}`;

/** The checklist, in the order the owner should work through it. */
export function setupSteps(o: SetupOverview): SetupStep[] {
  const imported = (kind: ImportKind) => o.imports_committed[kind] ?? 0;
  return [
    { key: "warehouse", done: o.main_warehouses > 0, count: o.main_warehouses, href: "#setup-warehouse" },
    { key: "territories", done: o.territories_with_coverage > 0, count: o.territories_with_coverage, total: o.territories, href: "#setup-territories" },
    { key: "people", done: o.employees > 1, count: o.employees, href: "#setup-people" },
    { key: "logins", done: o.employees > 0 && o.employees_with_login === o.employees, count: o.employees_with_login, total: o.employees, href: "#setup-people" },
    { key: "baseLocations", done: o.reps > 0 && o.reps_with_base_location === o.reps, count: o.reps_with_base_location, total: o.reps, href: "#setup-people" },
    { key: "catalog", done: o.legacy_catalog_missing.length === 0, count: o.legacy_catalog_missing.length, href: "#setup-imports" },
    { key: "products", done: imported("products") > 0 || o.variants > 0, count: o.variants, href: importHref("products") },
    { key: "prices", done: o.default_list_prices > 0, count: o.default_list_prices, href: importHref("customer_prices") },
    { key: "stock", done: imported("opening_stock") > 0, count: o.stock_units, href: importHref("opening_stock") },
    { key: "customers", done: imported("customers") > 0 || o.customers > 0, count: o.customers, href: importHref("customers") },
    { key: "openingAr", done: imported("opening_ar") > 0, count: o.opening_ar_entries, href: importHref("opening_ar") },
  ];
}

/** The converter's files (scripts/legacy/convert.ts), in upload order. */
export const IMPORT_SEQUENCE: readonly { file: string; kind: ImportKind; key: string }[] = [
  { file: "1-products.csv", kind: "products", key: "products" },
  { file: "2-base-prices.csv", kind: "customer_prices", key: "prices" },
  { file: "3-opening-stock.csv", kind: "opening_stock", key: "stock" },
  { file: "4-customers.csv", kind: "customers", key: "customers" },
  { file: "5-opening-ar.csv", kind: "opening_ar", key: "openingAr" },
  { file: "6-opening-ar-credits.csv", kind: "opening_ar", key: "credits" },
];

export type LinkMode = "invite" | "magiclink";

/**
 * The one-time link the owner copies to the person: our own confirm route verifies the token
 * hash (src/app/[locale]/auth/confirm/route.ts), so it works without any e-mail template.
 */
export function signInLinkUrl(appUrl: string, locale: "ar" | "en", hashedToken: string, mode: LinkMode): string {
  const url = new URL(`/${locale}/auth/confirm`, appUrl);
  url.searchParams.set("token_hash", hashedToken);
  url.searchParams.set("type", mode);
  return url.toString();
}

/** "31.0409, 31.3785" or "31.0409 31.3785" (as copied from a map) → numbers, or null. */
export function parseLatLngPair(text: string): { lat: number; lng: number } | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,،\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Google Maps link for checking a saved point (no key needed). */
export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
