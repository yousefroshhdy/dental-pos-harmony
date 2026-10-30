import type { AppError } from "@/lib/errors";
import { MASK_CATEGORIES, type AuditAction, type AuditEntry, type AuditFilters, type Json, type MaskCategory } from "./types";

/**
 * Pure presentation logic for the audit reader: field-level diffs, masked values,
 * record links and URLs. Showing something here is cosmetic: api.audit_* decides
 * who may read row images and masks sensitive values before they leave Postgres.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export const AUDIT_ERROR_CODES = ["PERMISSION_DENIED", "VALIDATION", "NOT_FOUND", "UNAVAILABLE", "MFA_REQUIRED", "UNKNOWN"] as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

export function auditErrorCode(error: Pick<AppError, "code" | "messageKey">): AuditErrorCode {
  const known = (c: string): c is AuditErrorCode => (AUDIT_ERROR_CODES as readonly string[]).includes(c);
  if (known(error.code)) return error.code;
  if (known(error.messageKey)) return error.messageKey;
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Masked values
// ---------------------------------------------------------------------------
const MASKED = /^\[masked:([a-z_]+)\]$/;

/** The category of a masked value ("[masked:phone]" → "phone"), else null. */
export function maskedCategory(value: Json | undefined): MaskCategory | "other" | null {
  if (typeof value !== "string") return null;
  const match = MASKED.exec(value);
  const category = match?.[1];
  if (!category) return null;
  return (MASK_CATEGORIES as readonly string[]).includes(category) ? (category as MaskCategory) : "other";
}

// ---------------------------------------------------------------------------
// Field-level diffs
// ---------------------------------------------------------------------------
export type ChangeKind = "added" | "removed" | "changed";

export interface FieldChange {
  field: string;
  kind: ChangeKind;
  before: Json | undefined;
  after: Json | undefined;
  /** Category when either side is masked (the values are then not shown). */
  masked: MaskCategory | "other" | null;
}

const isEmpty = (v: Json | undefined) => v === undefined || v === null;

/** Stable JSON for comparing values (object key order does not matter). */
export function stableJson(value: Json | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
    .join(",")}}`;
}

/**
 * The fields an entry touched, alphabetically. An insert lists every non-empty new value,
 * a delete every non-empty old value, an update the fields that changed (the trigger's
 * changed_fields when present, otherwise a comparison of the two images).
 */
export function fieldChanges(entry: Pick<AuditEntry, "action" | "old_data" | "new_data" | "changed_fields" | "masked">): FieldChange[] {
  const before = entry.old_data ?? {};
  const after = entry.new_data ?? {};
  const maskMap = entry.masked ?? {};
  let fields: string[];

  if (entry.action === "INSERT") {
    fields = Object.keys(after).filter((k) => !isEmpty(after[k]));
  } else if (entry.action === "DELETE") {
    fields = Object.keys(before).filter((k) => !isEmpty(before[k]));
  } else if (entry.changed_fields && entry.changed_fields.length > 0) {
    fields = [...new Set(entry.changed_fields)];
  } else {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    fields = [...keys].filter((k) => stableJson(before[k] ?? null) !== stableJson(after[k] ?? null));
  }

  return fields
    .sort((a, b) => a.localeCompare(b))
    .map((field) => {
      const b = entry.action === "INSERT" ? undefined : before[field];
      const a = entry.action === "DELETE" ? undefined : after[field];
      const kind: ChangeKind = entry.action === "INSERT" || (isEmpty(b) && !isEmpty(a)) ? "added" : entry.action === "DELETE" || (!isEmpty(b) && isEmpty(a)) ? "removed" : "changed";
      const category = maskedCategory(b) ?? maskedCategory(a) ?? toCategory(maskMap[field]);
      return { field, kind, before: b, after: a, masked: category };
    });
}

function toCategory(value: string | undefined): MaskCategory | "other" | null {
  if (!value) return null;
  return (MASK_CATEGORIES as readonly string[]).includes(value) ? (value as MaskCategory) : "other";
}

/** Display text for one value; null when it is empty (the UI shows an "empty" label). */
export function displayValue(value: Json | undefined): string | null {
  if (isEmpty(value)) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Long or structured values are shown in a <pre>. */
export function isBlockValue(value: Json | undefined): boolean {
  return value !== null && typeof value === "object";
}

// ---------------------------------------------------------------------------
// Records, tables, actors
// ---------------------------------------------------------------------------
export const tableRef = (schema: string, table: string) => `${schema}.${table}`;

/** Message key for a table name, e.g. tables.crm.customers. */
export const tableKey = (schema: string, table: string) => `tables.${schema}.${table}`;

const str = (v: Json | undefined): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const pathId = (v: string | null) => (v ? encodeURIComponent(v) : null);

type ImageField = (key: string) => string | null;

/** Routes that show a record of an audited table. Unlisted tables have no link. */
const RECORD_ROUTES: Record<string, (id: string | null, field: ImageField) => string | null> = {
  "crm.customers": (id) => id && `/customers/${id}`,
  "crm.customer_contacts": (_id, f) => f("customer_id") && `/customers/${f("customer_id")}`,
  "crm.customer_assignments": (_id, f) => f("customer_id") && `/customers/${f("customer_id")}`,
  "sales.orders": (id) => id && `/orders/${id}`,
  "sales.order_items": (_id, f) => f("order_id") && `/orders/${f("order_id")}`,
  "finance.invoices": (id) => id && `/finance/invoices/${id}`,
  "finance.credit_notes": (_id, f) => f("invoice_id") && `/finance/invoices/${f("invoice_id")}`,
  "finance.payments": (id) => id && `/finance/payments/${id}`,
  "catalog.products": (id) => id && `/catalog/products/${id}`,
  "catalog.product_variants": (_id, f) => f("product_id") && `/catalog/products/${f("product_id")}`,
  "catalog.price_lists": (id) => id && `/catalog/price-lists/${id}`,
  "catalog.price_list_items": (_id, f) => f("price_list_id") && `/catalog/price-lists/${f("price_list_id")}`,
  "wf.approval_requests": (id) => id && `/approvals/${id}`,
  "field.visits": (id) => id && `/visits/${id}`,
  "authz.roles": (id) => id && `/admin/roles/${id}`,
  "authz.user_roles": (_id, f) => f("user_id") && `/admin/users/${f("user_id")}`,
  "core.user_profiles": (_id, f) => f("user_id") && `/admin/users/${f("user_id")}`,
  "core.employees": (_id, f) => f("user_id") && `/admin/users/${f("user_id")}`,
};

/** Link to the record an entry belongs to, when the app has a page for it. */
export function recordHref(entry: Pick<AuditEntry, "table_schema" | "table_name" | "record_id" | "old_data" | "new_data">): string | null {
  const route = RECORD_ROUTES[tableRef(entry.table_schema, entry.table_name)];
  if (!route) return null;
  const field: ImageField = (key) => {
    const v = str(entry.new_data?.[key]) ?? str(entry.old_data?.[key]);
    return v && maskedCategory(v) === null ? pathId(v) : null;
  };
  return route(pathId(entry.record_id), field) || null;
}

/** The record timeline page for an entry (needs a record id). */
export function historyHref(schema: string, table: string, recordId: string | null): string | null {
  if (!recordId) return null;
  return `/audit/${encodeURIComponent(tableRef(schema, table))}/${encodeURIComponent(recordId)}`;
}

/** Actor name in the viewer's locale; null for system changes (no actor). */
export function actorName(locale: string, entry: Pick<AuditEntry, "actor_user_id" | "actor_name_en" | "actor_name_ar">): string | null {
  if (!entry.actor_user_id) return null;
  if (locale === "ar" && entry.actor_name_ar) return entry.actor_name_ar;
  return entry.actor_name_en ?? entry.actor_name_ar ?? entry.actor_user_id.slice(0, 8);
}

export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

export function actionTone(action: AuditAction): "success" | "info" | "danger" {
  return action === "INSERT" ? "success" : action === "DELETE" ? "danger" : "info";
}

/** Distinct categories masked in a list of entries (for the "hidden fields" notice). */
export function maskedCategories(entries: Pick<AuditEntry, "masked">[]): string[] {
  const out = new Set<string>();
  for (const e of entries) for (const c of Object.values(e.masked ?? {})) out.add(c);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
export function withQuery(path: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    params.set(k, v === true ? "1" : String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The search filters as URL query values (the inverse of parseAuditSearch). */
export function filtersToQuery(f: AuditFilters): Record<string, string | number | boolean | undefined> {
  return {
    table: f.tableSchema && f.tableName ? tableRef(f.tableSchema, f.tableName) : undefined,
    record: f.recordId,
    actor: f.actorUserId,
    from: f.from,
    to: f.to,
    action: f.action,
    reveal: f.reveal,
  };
}

/** Keyset paging: the next page starts below the smallest id shown (full page only). */
export function nextBeforeId(entries: Pick<AuditEntry, "id">[], pageSize: number): number | null {
  if (entries.length < pageSize) return null;
  return Math.min(...entries.map((e) => e.id));
}
