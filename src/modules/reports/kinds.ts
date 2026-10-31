import { can, type UserContext } from "@/lib/authz/can";

/**
 * The on-demand CSV exports (docs/DASHBOARDS.md §5, on-demand part), and who
 * may run each one. Each export needs the permission its list page checks AND
 * the kind's own `<module>.<resource>.export` permission (docs/AUTHORIZATION.md
 * §2, level 7; owner decision of 2026-10-31). Every export permission is
 * sensitive and MFA-gated (§6.7).
 *
 * Here it is UX and an early 403. The database enforces the same rule in
 * api.log_export (the `export-kinds` whitelist, latest in migration
 * 20261104001100; tests/unit/reports-export-log.test.ts keeps the two in
 * step), adding the MFA step-up and the rate limit. Rows come from the api.v_*
 * views through the user's own session, so RLS decides what is in the file.
 */
export const EXPORT_KINDS = ["orders", "order_lines", "invoices", "payments", "aging", "visits", "customers", "stock", "tracking"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === "string" && (EXPORT_KINDS as readonly string[]).includes(value);
}

/** Permission rule per export: every inner list is ANDed, the outer list ORed. */
export const EXPORT_PERMISSIONS: Record<ExportKind, readonly (readonly string[])[]> = {
  orders: [["sales.order.read", "sales.order.export"]],
  order_lines: [["sales.order.read", "sales.order.export"]],
  invoices: [["finance.invoice.read", "finance.invoice.export"]],
  payments: [["finance.payment.read", "finance.payment.export"]],
  aging: [
    ["finance.page.aging", "finance.aging.export"],
    ["finance.ledger.read", "finance.aging.export"],
  ],
  visits: [["field.visit.read", "field.visit.export"]],
  customers: [["crm.customer.read", "crm.customer.export"]],
  stock: [["inventory.stock.read", "inventory.stock.export"]],
  tracking: [["field.tracking.read", "field.tracking.export"]],
};

/** The dedicated export permission of each kind (the MFA-gated half of its rule). */
export const EXPORT_PERMISSION: Record<ExportKind, string> = {
  orders: "sales.order.export",
  order_lines: "sales.order.export",
  invoices: "finance.invoice.export",
  payments: "finance.payment.export",
  aging: "finance.aging.export",
  visits: "field.visit.export",
  customers: "crm.customer.export",
  stock: "inventory.stock.export",
  tracking: "field.tracking.export",
};

export function canExport(ctx: UserContext, kind: ExportKind): boolean {
  return EXPORT_PERMISSIONS[kind].some((all) => all.every((p) => can(ctx, p)));
}

export function availableExports(ctx: UserContext): ExportKind[] {
  return EXPORT_KINDS.filter((k) => canExport(ctx, k));
}

/** Stock: inventory roles get the full per-warehouse view; everyone else sellable availability. */
export const fullStock = (ctx: UserContext) => can(ctx, "inventory.module.access");
/** Aging: ledger balance and unapplied credit are shown only with finance.ledger.read (as on the page). */
export const ledgerColumns = (ctx: UserContext) => can(ctx, "finance.ledger.read");
/** Visits: wider read scopes may export the team's visits; "own" exports their own (RLS anyway). */
export const mayBrowseOtherVisits = (ctx: UserContext) => can(ctx, "field.visit.read", "team");

/** Filter fields the /reports form shows per export (names are the query parameters). */
export const FILTER_FIELDS: Record<ExportKind, readonly string[]> = {
  orders: ["status", "from", "to"],
  order_lines: ["status", "from", "to"],
  invoices: ["status", "bucket", "customer", "from", "to"],
  payments: ["status", "customer", "from", "to"],
  aging: [],
  visits: ["status", "who", "from", "to"],
  customers: ["q", "stage", "territory", "specialty"],
  stock: ["warehouse", "brand"],
  tracking: ["date"],
};

export type ExportFilters = Record<string, string | null | undefined>;

/**
 * Link to an export. Empty values are dropped, so a list page can pass its
 * parsed filters as they are.
 */
export function exportHref(kind: ExportKind, filters: ExportFilters = {}, locale?: string): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, value);
  }
  if (locale) qs.set("locale", locale);
  const s = qs.toString();
  return `/api/export/${kind}${s ? `?${s}` : ""}`;
}
