import { z } from "zod";
import { LIFECYCLE_STAGES } from "@/modules/crm/types";
import { VISIT_STATUSES } from "@/modules/field/types";
import { INVOICE_FILTERS, PAYMENT_FILTERS } from "@/modules/finance/logic";
import { AGING_BUCKETS } from "@/modules/finance/types";
import { STATUS_FILTERS } from "@/modules/orders/logic";
import type { ExportKind } from "./kinds";

/**
 * Export filters, validated from the query string. Names and values mirror the
 * list pages (`/orders?status=awaiting`, `/finance/invoices?status=open&customer=…`)
 * so a list page can link to its own export; `from`/`to` (Cairo calendar days)
 * are added because a file usually covers a period. Unlike the pages, an
 * invalid value is a 400, not a silent fallback.
 */

const id = z.guid();
const day = z.iso.date();
const keys = <T extends Record<string, unknown>>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const range = {
  from: day.optional(),
  to: day.optional(),
};
const rangeOrdered = (f: { from?: string; to?: string }) => !f.from || !f.to || f.from <= f.to;
const rangeIssue = { message: "from must not be after to", path: ["to"] };

export const ordersFilterSchema = z
  .object({ status: z.enum(keys(STATUS_FILTERS)).default("all"), ...range })
  .refine(rangeOrdered, rangeIssue);

export const invoicesFilterSchema = z
  .object({
    status: z.enum(keys(INVOICE_FILTERS)).default("open"),
    bucket: z.enum(AGING_BUCKETS).optional(),
    customer: id.optional(),
    ...range,
  })
  .refine(rangeOrdered, rangeIssue)
  // As on the invoices page: a bucket drill-down always means open invoices.
  .transform((f) => (f.bucket ? { ...f, status: "open" as const } : f));

export const paymentsFilterSchema = z
  .object({ status: z.enum(keys(PAYMENT_FILTERS)).default("all"), customer: id.optional(), ...range })
  .refine(rangeOrdered, rangeIssue);

export const agingFilterSchema = z.object({});

export const visitsFilterSchema = z
  .object({ status: z.enum(VISIT_STATUSES).optional(), who: z.enum(["mine", "all"]).default("mine"), ...range })
  .refine(rangeOrdered, rangeIssue);

export const customersFilterSchema = z.object({
  q: z.string().trim().max(80).optional(),
  stage: z.enum(LIFECYCLE_STAGES).optional(),
  territory: id.optional(),
  specialty: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/)
    .optional(),
});

export const stockFilterSchema = z.object({ warehouse: id.optional(), brand: id.optional(), product: id.optional() });

export const trackingFilterSchema = z.object({ date: day.optional() });

export const FILTER_SCHEMAS = {
  orders: ordersFilterSchema,
  order_lines: ordersFilterSchema,
  invoices: invoicesFilterSchema,
  payments: paymentsFilterSchema,
  aging: agingFilterSchema,
  visits: visitsFilterSchema,
  customers: customersFilterSchema,
  stock: stockFilterSchema,
  tracking: trackingFilterSchema,
} as const satisfies Record<ExportKind, z.ZodType>;

export type OrdersFilter = z.infer<typeof ordersFilterSchema>;
export type InvoicesFilter = z.infer<typeof invoicesFilterSchema>;
export type PaymentsFilter = z.infer<typeof paymentsFilterSchema>;
export type VisitsFilter = z.infer<typeof visitsFilterSchema>;
export type CustomersFilter = z.infer<typeof customersFilterSchema>;
export type StockFilter = z.infer<typeof stockFilterSchema>;
export type TrackingFilter = z.infer<typeof trackingFilterSchema>;

/** Query parameters that are not filters. */
const RESERVED = new Set(["locale"]);

/** URLSearchParams → first value per key, trimmed; empty values (an unset form select) dropped. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key) || key in out) continue;
    const value = raw.trim();
    if (value !== "") out[key] = value;
  }
  return out;
}

export type FilterResult = { ok: true; filters: Record<string, unknown> } | { ok: false; fields: string[] };

export function parseExportFilters(kind: ExportKind, params: URLSearchParams): FilterResult {
  const parsed = FILTER_SCHEMAS[kind].safeParse(searchParamsToObject(params));
  if (parsed.success) return { ok: true, filters: parsed.data as Record<string, unknown> };
  return { ok: false, fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))] };
}

/** The locale for headers and names: `?locale=` if valid, else the user's preference. */
export function exportLocale(params: URLSearchParams, fallback: "ar" | "en"): "ar" | "en" {
  const v = params.get("locale");
  return v === "ar" || v === "en" ? v : fallback;
}

/** Filter shape keys (for checking the /reports form against the schema). */
export function filterKeysOf(kind: ExportKind): string[] {
  const schema = FILTER_SCHEMAS[kind] as z.ZodType;
  // Unwrap refine/transform pipes down to the object.
  let s: unknown = schema;
  for (let i = 0; i < 5; i++) {
    const def = (s as { def?: { type?: string; in?: unknown; schema?: unknown } }).def;
    if (def?.type === "object") break;
    s = def?.in ?? def?.schema ?? s;
  }
  return Object.keys((s as z.ZodObject).shape ?? {});
}
