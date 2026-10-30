import type { UserContext } from "@/lib/authz/can";
import { LIFECYCLE_STAGES } from "@/modules/crm/types";
import { VISIT_STATUSES } from "@/modules/field/types";
import { INVOICE_FILTERS, PAYMENT_FILTERS } from "@/modules/finance/logic";
import { AGING_BUCKETS } from "@/modules/finance/types";
import { STATUS_FILTERS } from "@/modules/orders/logic";
import { FILTER_FIELDS, fullStock, mayBrowseOtherVisits, type ExportKind } from "./kinds";

/**
 * The /reports filter form of each export, as data (rendered by
 * components/export-form.tsx). Field names are the export's query
 * parameters; the schemas in schemas.ts validate them again on the server.
 */

/** One picker option read from the database. */
export interface Option {
  value: string;
  label: string;
}

/** Pickers whose options are read from the database. */
export type DynamicOptions = "customers" | "territories" | "specialties" | "warehouses" | "brands";
/** Message group under `reports.options.*` for fixed code lists. */
export type OptionGroup = "orderStatus" | "invoiceStatus" | "paymentStatus" | "bucket" | "visitStatus" | "stage" | "who";

export type FieldSpec =
  | { name: string; control: "select"; codes: readonly string[]; group: OptionGroup; defaultValue?: string; anyOption: boolean }
  | { name: string; control: "dynamic"; source: DynamicOptions }
  | { name: string; control: "date"; defaultToday?: boolean }
  | { name: string; control: "search" };

const keys = (o: object) => Object.keys(o);

function spec(kind: ExportKind, name: string, ctx: UserContext): FieldSpec | null {
  switch (name) {
    case "status":
      if (kind === "orders" || kind === "order_lines") return { name, control: "select", codes: keys(STATUS_FILTERS), group: "orderStatus", defaultValue: "all", anyOption: false };
      if (kind === "invoices") return { name, control: "select", codes: keys(INVOICE_FILTERS), group: "invoiceStatus", defaultValue: "open", anyOption: false };
      if (kind === "payments") return { name, control: "select", codes: keys(PAYMENT_FILTERS), group: "paymentStatus", defaultValue: "all", anyOption: false };
      if (kind === "visits") return { name, control: "select", codes: VISIT_STATUSES, group: "visitStatus", anyOption: true };
      return null;
    case "bucket":
      return { name, control: "select", codes: AGING_BUCKETS, group: "bucket", anyOption: true };
    case "stage":
      return { name, control: "select", codes: LIFECYCLE_STAGES, group: "stage", anyOption: true };
    case "who":
      return mayBrowseOtherVisits(ctx) ? { name, control: "select", codes: ["mine", "all"], group: "who", defaultValue: "mine", anyOption: false } : null;
    case "customer":
      return { name, control: "dynamic", source: "customers" };
    case "territory":
      return { name, control: "dynamic", source: "territories" };
    case "specialty":
      return { name, control: "dynamic", source: "specialties" };
    case "warehouse":
      return { name, control: "dynamic", source: "warehouses" };
    case "brand":
      // v_stock_available has no brand; only the full stock view filters by brand.
      return fullStock(ctx) ? { name, control: "dynamic", source: "brands" } : null;
    case "from":
    case "to":
      return { name, control: "date" };
    case "date":
      return { name, control: "date", defaultToday: true };
    case "q":
      return { name, control: "search" };
    default:
      return null;
  }
}

export function fieldSpecs(kind: ExportKind, ctx: UserContext): FieldSpec[] {
  return FILTER_FIELDS[kind].map((name) => spec(kind, name, ctx)).filter((s): s is FieldSpec => s !== null);
}

/** The database-backed pickers a set of exports needs (so the page reads only those). */
export function dynamicSourcesFor(kinds: readonly ExportKind[], ctx: UserContext): Set<DynamicOptions> {
  const out = new Set<DynamicOptions>();
  for (const k of kinds) for (const f of fieldSpecs(k, ctx)) if (f.control === "dynamic") out.add(f.source);
  return out;
}

/** Message key of a fixed option. */
export function optionLabelKey(group: OptionGroup, code: string): string {
  if (group === "who") return code === "all" ? "filters.everyone" : "filters.mine";
  return `options.${group}.${code}`;
}
