import type { UserContext } from "@/lib/authz/can";
import arMessages from "../../../messages/ar/reports.json";
import enMessages from "../../../messages/en/reports.json";
import { cairoDateTime, CsvNumber, decimal, integer, isoDate, money, type CsvValue } from "./csv";
import { fullStock, ledgerColumns, type ExportKind } from "./kinds";

/**
 * Column layout of each export. Values come straight from the api views (or
 * the tracking RPC); nothing is computed here except unit conversions
 * (seconds → minutes, metres → km) and the locale's choice of name.
 * Statuses and other codes are exported as their stable codes.
 */

export type ColumnType = "text" | "money" | "int" | "number" | "date" | "datetime" | "bool" | "list";
export type Locale = "ar" | "en";
export type Row = Record<string, unknown>;

export interface Column {
  /** Header key under `reports.columns.*`. */
  key: string;
  type: ColumnType;
  /** Source field (defaults to `key`). */
  field?: string;
  /** Localized name: [english field, arabic field]. */
  name?: readonly [string, string];
  value?: (row: Row) => unknown;
}

type Layout = readonly Column[] | ((ctx: UserContext) => readonly Column[]);

const t = (key: string, type: ColumnType = "text", extra: Partial<Column> = {}): Column => ({ key, type, ...extra });
const minutes = (field: string) => (row: Row) => (typeof row[field] === "number" ? Math.round((row[field] as number) / 60) : null);

const ORDER_COLUMNS: readonly Column[] = [
  t("order_no"),
  t("status"),
  t("customer_name"),
  t("employee_name"),
  t("created_at", "datetime"),
  t("submitted_at", "datetime"),
  t("approved_at", "datetime"),
  t("payment_terms_days", "int"),
  t("currency"),
  t("subtotal", "money"),
  t("discount_total", "money"),
  t("tax_total", "money"),
  t("total", "money"),
  t("notes"),
];

const ORDER_LINE_COLUMNS: readonly Column[] = [
  t("order_no"),
  t("order_status", "text", { field: "status" }),
  t("customer_name"),
  t("order_created_at", "datetime", { field: "created_at" }),
  t("line_no", "int"),
  t("sku"),
  t("variant_name"),
  t("quantity", "int"),
  t("list_price", "money"),
  t("applied_discount_pct", "number"),
  t("tax_rate_pct", "number"),
  t("line_subtotal", "money"),
  t("line_discount", "money"),
  t("line_tax", "money"),
  t("line_total", "money"),
  t("fulfilled_qty", "int"),
  t("reserved_qty", "int"),
  t("returned_qty", "int"),
];

const INVOICE_COLUMNS: readonly Column[] = [
  t("invoice_no"),
  t("order_no"),
  t("customer_no"),
  t("customer_name"),
  t("rep_name", "text", { name: ["rep_name_en", "rep_name_ar"] }),
  t("issue_date", "date"),
  t("due_date", "date"),
  t("status"),
  t("currency"),
  t("subtotal", "money"),
  t("discount_total", "money"),
  t("tax_total", "money"),
  t("total", "money"),
  t("allocated", "money"),
  t("credited", "money"),
  t("open_amount", "money"),
  t("days_overdue", "int"),
  t("aging_bucket"),
  t("eta_status"),
];

const PAYMENT_COLUMNS: readonly Column[] = [
  t("payment_no"),
  t("customer_no"),
  t("customer_name"),
  t("collected_by", "text", { name: ["collected_by_name_en", "collected_by_name_ar"] }),
  t("method"),
  t("status"),
  t("amount", "money"),
  t("allocated", "money"),
  t("unallocated", "money"),
  t("received_at", "datetime"),
  t("reference"),
  t("cheque_due_date", "date"),
  t("confirmed_at", "datetime"),
  t("reversed_at", "datetime"),
  t("status_reason"),
];

const AGING_BASE: readonly Column[] = [
  t("customer_no"),
  t("customer_name"),
  t("territory_code"),
  t("territory_name", "text", { name: ["territory_name_en", "territory_name_ar"] }),
  t("rep_name", "text", { name: ["rep_name_en", "rep_name_ar"] }),
  t("current_amount", "money"),
  t("d1_30", "money"),
  t("d31_60", "money"),
  t("d61_90", "money"),
  t("d90_plus", "money"),
  t("total_open", "money"),
  t("overdue_amount", "money"),
  t("open_invoices", "int"),
  t("overdue_invoices", "int"),
  t("max_days_overdue", "int"),
];
const AGING_LEDGER: readonly Column[] = [t("ledger_balance", "money"), t("unapplied_credit", "money")];

const VISIT_COLUMNS: readonly Column[] = [
  t("customer_no"),
  t("customer_name"),
  t("employee_name", "text", { name: ["employee_name_en", "employee_name_ar"] }),
  t("planned_for", "date"),
  t("status"),
  t("check_in_at", "datetime"),
  t("check_out_at", "datetime"),
  t("check_in_distance_m", "number"),
  t("check_in_accuracy_m", "number"),
  t("verification_status"),
  t("anomaly_flags", "list"),
  t("outcome"),
  t("notes"),
];

/**
 * Customers: the list page's fields only (data minimisation, D-03). The phone
 * is whatever api.v_customers returns for this user; if the view masks it,
 * the cell is empty. No address, e-mail, coordinates or balance.
 */
const CUSTOMER_COLUMNS: readonly Column[] = [
  t("customer_no"),
  t("display_name"),
  t("doctor_name"),
  t("lifecycle_stage"),
  t("specialty_code"),
  t("phone_primary"),
  t("city"),
  t("governorate_code"),
  t("territory_name", "text", { name: ["territory_name_en", "territory_name_ar"] }),
  t("primary_rep_name", "text", { name: ["primary_rep_name_en", "primary_rep_name_ar"] }),
  t("location_verified", "bool"),
];

const STOCK_FULL: readonly Column[] = [
  t("warehouse_code"),
  t("warehouse_name"),
  t("warehouse_kind"),
  t("is_sellable", "bool"),
  t("sku"),
  t("variant_name"),
  t("product_name"),
  t("brand_code"),
  t("reorder_point", "int"),
  t("on_hand", "int"),
  t("reserved", "int"),
  t("available", "int"),
  t("sellable_available", "int"),
  t("expired_qty", "int"),
  t("near_expiry_qty", "int"),
  t("earliest_expiry", "date"),
  t("lot_count", "int"),
];
const STOCK_AVAILABLE: readonly Column[] = [t("warehouse_code"), t("warehouse_name"), t("sku"), t("variant_name"), t("product_name"), t("available", "int")];

const TRACKING_COLUMNS: readonly Column[] = [
  t("employee_no"),
  t("employee_name", "text", { name: ["full_name_en", "full_name_ar"] }),
  t("business_date", "date"),
  t("on_shift", "bool"),
  t("shift_count", "int"),
  t("shift_minutes", "int", { value: minutes("shift_seconds") }),
  t("first_start_at", "datetime"),
  t("last_end_at", "datetime"),
  t("visit_count", "int"),
  t("visit_minutes", "int", { value: minutes("visit_seconds") }),
  t("idle_stop_count", "int"),
  t("idle_stop_minutes", "int", { value: minutes("idle_stop_seconds") }),
  t("gap_count", "int"),
  t("gap_minutes", "int", { value: minutes("gap_seconds") }),
  t("distance_km", "number", { value: (r) => (typeof r.distance_m === "number" || typeof r.distance_m === "string" ? CsvNumber.of(Number(r.distance_m) / 1000, 2) : null) }),
  t("ping_count", "int"),
  t("last_ping_at", "datetime"),
  t("flags", "list"),
  t("from_summary", "bool"),
];

export const LAYOUTS: Record<ExportKind, Layout> = {
  orders: ORDER_COLUMNS,
  order_lines: ORDER_LINE_COLUMNS,
  invoices: INVOICE_COLUMNS,
  payments: PAYMENT_COLUMNS,
  aging: (ctx) => (ledgerColumns(ctx) ? [...AGING_BASE, ...AGING_LEDGER] : AGING_BASE),
  visits: VISIT_COLUMNS,
  customers: CUSTOMER_COLUMNS,
  stock: (ctx) => (fullStock(ctx) ? STOCK_FULL : STOCK_AVAILABLE),
  tracking: TRACKING_COLUMNS,
};

export function columnsFor(kind: ExportKind, ctx: UserContext): readonly Column[] {
  const layout = LAYOUTS[kind];
  return typeof layout === "function" ? layout(ctx) : layout;
}

/** Every column any user could get (for the messages test). */
export function allColumnKeys(): string[] {
  const full = { active: true, is_owner: true } as UserContext;
  const none = { active: true, is_owner: false, permissions: {} } as unknown as UserContext;
  const keys = new Set<string>();
  for (const layout of Object.values(LAYOUTS)) {
    for (const ctx of [full, none]) for (const c of typeof layout === "function" ? layout(ctx) : layout) keys.add(c.key);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
// Messages (headers and notes are read from messages/<locale>/reports.json
// directly: the route handler runs outside the [locale] tree)
// ---------------------------------------------------------------------------

const MESSAGES = { ar: arMessages, en: enMessages } as const;

export function columnHeader(locale: Locale, key: string): string {
  return (MESSAGES[locale].columns as Record<string, string>)[key] ?? key;
}

export function headersFor(columns: readonly Column[], locale: Locale): string[] {
  return columns.map((c) => columnHeader(locale, c.key));
}

export function csvNote(locale: Locale, key: "truncated" | "incomplete", count?: number): string {
  const text = (MESSAGES[locale].csv as Record<string, string>)[key] ?? key;
  return text.replace("{count}", count === undefined ? "" : String(count));
}

function localizedName(locale: Locale, en: unknown, ar: unknown): string | null {
  const pick = locale === "ar" ? (ar ?? en) : (en ?? ar);
  return typeof pick === "string" && pick !== "" ? pick : null;
}

/** One cell, typed for the encoder. */
export function cellValue(column: Column, row: Row, locale: Locale): CsvValue {
  const raw = column.value ? column.value(row) : column.name ? localizedName(locale, row[column.name[0]], row[column.name[1]]) : row[column.field ?? column.key];
  if (raw === null || raw === undefined) return null;
  if (raw instanceof CsvNumber) return raw;
  switch (column.type) {
    case "money":
      return money(raw);
    case "int":
      return integer(raw);
    case "number":
      return decimal(raw);
    case "date":
      return isoDate(raw) ?? cairoDateTime(raw)?.slice(0, 10) ?? null;
    case "datetime":
      return cairoDateTime(raw);
    case "bool": {
      if (typeof raw !== "boolean") return null;
      return (MESSAGES[locale].csv as Record<string, string>)[raw ? "yes" : "no"];
    }
    case "list":
      return Array.isArray(raw) ? raw.map(String).join("; ") : String(raw);
    case "text":
      return typeof raw === "string" ? raw : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  }
}

export function rowValues(columns: readonly Column[], row: Row, locale: Locale): CsvValue[] {
  return columns.map((c) => cellValue(c, row, locale));
}
