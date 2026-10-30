import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserContext } from "@/lib/authz/can";
import type { DbErrorLike } from "@/lib/errors";
import { customerSearchFilter } from "@/modules/crm/logic";
import { INVOICE_FILTERS, PAYMENT_FILTERS } from "@/modules/finance/logic";
import { STATUS_FILTERS } from "@/modules/orders/logic";
import type { Row } from "./columns";
import { cairoDayStartUtc, cairoToday, nextDay } from "./csv";
import { fullStock, mayBrowseOtherVisits, type ExportKind } from "./kinds";
import type { CustomersFilter, InvoicesFilter, OrdersFilter, PaymentsFilter, StockFilter, TrackingFilter, VisitsFilter } from "./schemas";

/**
 * Where each export reads from. Every read goes through the caller's own
 * Supabase client (anon key + session), so RLS and the views' masking apply
 * exactly as on the list pages. Never pass the service-role client here.
 *
 * Each source is an async generator of non-empty row batches; the caller
 * stops pulling once it has enough rows.
 */

// The api schema has no generated types; rows are read as plain records.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = SupabaseClient<any, any, any>;

/** A PostgREST read failed; carries the error for parseDbError. */
export class ExportReadError extends Error {
  constructor(
    readonly view: string,
    readonly dbError: DbErrorLike,
  ) {
    super(`${view}: ${dbError.code ?? ""} ${dbError.message ?? ""}`);
  }
}

type PageResult = { data: unknown; error: DbErrorLike | null };
type PageQuery = PromiseLike<PageResult>;

/** Rows per request. PostgREST may cap a response lower (max-rows); paging uses what actually came back. */
export const PAGE_SIZE = 1000;

/**
 * Offset paging over an ordered query until `limit` rows or an empty page.
 * The order must be total (ends with a unique column) so pages don't overlap.
 */
export async function* paged(view: string, build: (from: number, to: number) => PageQuery, limit: number, pageSize = PAGE_SIZE): AsyncGenerator<Row[]> {
  let offset = 0;
  while (offset < limit) {
    const size = Math.min(pageSize, limit - offset);
    const { data, error } = await build(offset, offset + size - 1);
    if (error) throw new ExportReadError(view, error);
    const rows = (Array.isArray(data) ? data : []) as Row[];
    if (rows.length === 0) return;
    yield rows;
    offset += rows.length;
  }
}

export interface SourceArgs {
  db: Db;
  ctx: UserContext;
  filters: Record<string, unknown>;
  /** Stop after this many rows (the cap + 1, to detect truncation). */
  limit: number;
  now: Date;
}

type Source = (args: SourceArgs) => AsyncGenerator<Row[]>;

// Supabase's builder types are deep generics; sources only chain filter calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

function cairoRange(q: Builder, column: string, from?: string, to?: string): Builder {
  if (from) q = q.gte(column, cairoDayStartUtc(from));
  if (to) q = q.lt(column, cairoDayStartUtc(nextDay(to)));
  return q;
}

function dateRange(q: Builder, column: string, from?: string, to?: string): Builder {
  if (from) q = q.gte(column, from);
  if (to) q = q.lte(column, to);
  return q;
}

const ORDER_SELECT =
  "id, order_no, customer_name, employee_name, status, currency, payment_terms_days, subtotal, discount_total, tax_total, total, notes, submitted_at, approved_at, created_at";

function ordersQuery(db: Db, f: OrdersFilter, select: string): Builder {
  let q: Builder = db.from("v_orders").select(select);
  const statuses = STATUS_FILTERS[f.status];
  if (statuses.length > 0) q = q.in("status", [...statuses]);
  q = cairoRange(q, "created_at", f.from, f.to);
  return q.order("created_at", { ascending: false }).order("id", { ascending: false });
}

const orders: Source = ({ db, filters, limit }) =>
  paged("v_orders", (a, b) => ordersQuery(db, filters as OrdersFilter, ORDER_SELECT).range(a, b), limit);

const LINE_SELECT =
  "order_item_id, order_id, line_no, sku, variant_name, quantity, list_price, applied_discount_pct, tax_rate_pct, " +
  "line_subtotal, line_discount, line_tax, line_total, fulfilled_qty, reserved_qty, returned_qty";

/** Orders per line request (keeps the `in.(…)` list well inside URL limits). */
export const ORDER_BATCH = 100;

/** Lines of the filtered orders, in the orders' order; each line carries its order's number, status and customer. */
async function* orderLines({ db, filters, limit }: SourceArgs): AsyncGenerator<Row[]> {
  let emitted = 0;
  for await (const batch of paged("v_orders", (a, b) => ordersQuery(db, filters as OrdersFilter, "id, order_no, status, customer_name, created_at").range(a, b), Number.MAX_SAFE_INTEGER, ORDER_BATCH)) {
    const index = new Map(batch.map((o, i) => [o.id as string, i]));
    const lines: Row[] = [];
    for await (const page of paged(
      "v_order_lines",
      (a, b) =>
        db
          .from("v_order_lines")
          .select(LINE_SELECT)
          .in("order_id", [...index.keys()])
          .order("order_id")
          .order("line_no")
          .order("order_item_id")
          .range(a, b),
      Number.MAX_SAFE_INTEGER,
    )) {
      lines.push(...page);
    }
    lines.sort((x, y) => (index.get(x.order_id as string) ?? 0) - (index.get(y.order_id as string) ?? 0) || Number(x.line_no) - Number(y.line_no));
    const out = lines.slice(0, limit - emitted).map((l) => {
      const o = batch[index.get(l.order_id as string) ?? 0] ?? {};
      return { ...l, order_no: o.order_no, status: o.status, customer_name: o.customer_name, created_at: o.created_at };
    });
    if (out.length > 0) {
      yield out;
      emitted += out.length;
      if (emitted >= limit) return;
    }
  }
}

const INVOICE_SELECT =
  "id, invoice_no, order_no, customer_no, customer_name, rep_name_en, rep_name_ar, issue_date, due_date, status, currency, " +
  "subtotal, discount_total, tax_total, total, allocated, credited, open_amount, days_overdue, aging_bucket, eta_status";

/** Mirrors finance listInvoices: the same status sets, overdue and open-amount rules. */
const invoices: Source = ({ db, filters, limit }) => {
  const f = filters as InvoicesFilter;
  const build = (a: number, b: number) => {
    let q: Builder = db.from("v_invoices").select(INVOICE_SELECT);
    const statuses = INVOICE_FILTERS[f.status];
    if (statuses.length > 0) q = q.in("status", [...statuses]);
    if (f.status === "overdue") q = q.eq("is_overdue", true);
    if (f.status === "open" || f.status === "overdue") q = q.gt("open_amount", 0);
    if (f.customer) q = q.eq("customer_id", f.customer);
    if (f.bucket) q = q.eq("aging_bucket", f.bucket);
    q = dateRange(q, "issue_date", f.from, f.to);
    q = f.status === "open" || f.status === "overdue" ? q.order("due_date") : q.order("issue_date", { ascending: false });
    return q.order("invoice_no", { ascending: false }).order("id").range(a, b);
  };
  return paged("v_invoices", build, limit);
};

const PAYMENT_SELECT =
  "id, payment_no, customer_no, customer_name, collected_by_name_en, collected_by_name_ar, method, amount, allocated, " +
  "unallocated, received_at, reference, cheque_due_date, status, status_reason, confirmed_at, reversed_at";

const payments: Source = ({ db, filters, limit }) => {
  const f = filters as PaymentsFilter;
  const build = (a: number, b: number) => {
    let q: Builder = db.from("v_payments").select(PAYMENT_SELECT);
    const statuses = PAYMENT_FILTERS[f.status];
    if (statuses.length > 0) q = q.in("status", [...statuses]);
    if (f.status === "unallocated") q = q.gt("unallocated", 0);
    if (f.customer) q = q.eq("customer_id", f.customer);
    q = cairoRange(q, "received_at", f.from, f.to);
    return q.order("received_at", { ascending: false }).order("id").range(a, b);
  };
  return paged("v_payments", build, limit);
};

const AGING_SELECT =
  "customer_id, customer_no, customer_name, territory_code, territory_name_en, territory_name_ar, rep_name_en, rep_name_ar, " +
  "current_amount, d1_30, d31_60, d61_90, d90_plus, total_open, overdue_amount, open_invoices, overdue_invoices, " +
  "max_days_overdue, ledger_balance, unapplied_credit";

const aging: Source = ({ db, limit }) =>
  paged("v_ar_aging", (a, b) => db.from("v_ar_aging").select(AGING_SELECT).order("overdue_amount", { ascending: false }).order("customer_id").range(a, b), limit);

const VISIT_SELECT =
  "id, customer_no, customer_name, employee_id, employee_name_en, employee_name_ar, planned_for, status, check_in_at, " +
  "check_out_at, check_in_distance_m, check_in_accuracy_m, verification_status, anomaly_flags, outcome, notes";

/**
 * A visit's day is its check-in (Cairo) or, before check-in, its planned date.
 * PostgREST or() syntax; timestamps are quoted because they contain ':' and '.'.
 */
export function visitDayFilter(from?: string, to?: string): string | null {
  if (!from && !to) return null;
  const checked = [from && `check_in_at.gte."${cairoDayStartUtc(from)}"`, to && `check_in_at.lt."${cairoDayStartUtc(nextDay(to))}"`].filter(Boolean);
  const planned = ["check_in_at.is.null", from && `planned_for.gte.${from}`, to && `planned_for.lte.${to}`].filter(Boolean);
  return `and(${checked.join(",")}),and(${planned.join(",")})`;
}

/** Mirrors the visits page: "mine" is the caller's own visits; "all" needs a team-or-wider read scope. */
const visits: Source = ({ db, ctx, filters, limit }) => {
  const f = filters as VisitsFilter;
  const who = mayBrowseOtherVisits(ctx) && f.who === "all" ? "all" : "mine";
  const employeeId = who === "mine" ? ctx.employee?.id : undefined;
  const build = (a: number, b: number) => {
    let q: Builder = db.from("v_visits").select(VISIT_SELECT);
    if (employeeId) q = q.eq("employee_id", employeeId);
    if (f.status) q = q.eq("status", f.status);
    const day = visitDayFilter(f.from, f.to);
    if (day) q = q.or(day);
    return q
      .order("check_in_at", { ascending: false, nullsFirst: true })
      .order("planned_for", { ascending: false, nullsFirst: false })
      .order("id")
      .range(a, b);
  };
  return paged("v_visits", build, limit);
};

const CUSTOMER_SELECT =
  "id, customer_no, display_name, doctor_name, lifecycle_stage, specialty_code, phone_primary, city, governorate_code, " +
  "territory_name_en, territory_name_ar, primary_rep_name_en, primary_rep_name_ar, location_verified";

/** Mirrors the customers page: active (not archived) customers, the same search and filters. */
const customers: Source = ({ db, filters, limit }) => {
  const f = filters as CustomersFilter;
  const build = (a: number, b: number) => {
    let q: Builder = db.from("v_customers").select(CUSTOMER_SELECT).is("archived_at", null);
    const search = customerSearchFilter(f.q);
    if (search) q = q.or(search);
    if (f.stage) q = q.eq("lifecycle_stage", f.stage);
    if (f.territory) q = q.eq("territory_id", f.territory);
    if (f.specialty) q = q.eq("specialty_code", f.specialty);
    return q.order("display_name").order("id").range(a, b);
  };
  return paged("v_customers", build, limit);
};

const STOCK_FULL_SELECT =
  "warehouse_id, warehouse_code, warehouse_name, warehouse_kind, is_sellable, variant_id, sku, variant_name, product_name, " +
  "brand_code, reorder_point, on_hand, reserved, available, sellable_available, expired_qty, near_expiry_qty, earliest_expiry, lot_count";
const STOCK_AVAILABLE_SELECT = "warehouse_id, warehouse_code, warehouse_name, variant_id, sku, variant_name, product_name, available";

/** Mirrors the stock page: inventory roles read v_inventory_stock, others sellable availability only. */
const stock: Source = ({ db, ctx, filters, limit }) => {
  const f = filters as StockFilter;
  const full = fullStock(ctx);
  const view = full ? "v_inventory_stock" : "v_stock_available";
  const build = (a: number, b: number) => {
    let q: Builder = db.from(view).select(full ? STOCK_FULL_SELECT : STOCK_AVAILABLE_SELECT);
    if (f.warehouse) q = q.eq("warehouse_id", f.warehouse);
    if (f.brand && full) q = q.eq("brand_id", f.brand);
    if (f.product) q = q.eq("product_id", f.product);
    return q.order("sku").order("warehouse_code").order("variant_id").order("warehouse_id").range(a, b);
  };
  return paged(view, build, limit);
};

/** api.tracking_team_day for one Cairo day (the RPC checks field.tracking.read and its scope). */
const tracking: Source = ({ db, filters, limit, now }) => {
  const f = filters as TrackingFilter;
  const day = f.date ?? cairoToday(now);
  return paged("tracking_team_day", (a, b) => db.rpc("tracking_team_day", { p_day: day }).range(a, b), limit);
};

export const SOURCES: Record<ExportKind, Source> = {
  orders,
  order_lines: orderLines,
  invoices,
  payments,
  aging,
  visits,
  customers,
  stock,
  tracking,
};
