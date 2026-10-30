import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { RETURNABLE_ORDER_STATUSES, STATUS_FILTERS, type StatusFilter } from "./logic";
import type { ReturnableLineRow, ReturnCreditNoteRow, ReturnLineRow, ReturnOrderRow, ReturnRow, WarehouseOption } from "./types";

/**
 * Returns reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides what comes back: reps see the returns of
 * their own orders, inventory and finance see every return.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "returns.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "returns.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const LIST_LIMIT = 200;

const RETURN_COLUMNS =
  "id, return_no, order_id, order_no, order_status, customer_id, customer_no, customer_name, rep_employee_id, rep_name_en, " +
  "rep_name_ar, territory_id, status, reason, notes, warehouse_id, warehouse_code, warehouse_name, approval_request_id, " +
  "approval_status, created_by, requested_by_name_en, requested_by_name_ar, is_mine, created_at, decided_at, received_at, " +
  "credited_at, updated_at, lines, total_qty, credited_qty, estimated_total, credit_notes, credited_total";
const LINE_COLUMNS =
  "return_item_id, return_id, order_item_id, line_no, variant_id, sku, variant_name, lot_id, lot_no, expiry_date, quantity, " +
  "credited_qty, reason_code, condition, list_price, applied_discount_pct, tax_rate_pct, estimated_total";
const RETURNABLE_COLUMNS =
  "order_id, order_item_id, line_no, variant_id, sku, variant_name, lot_id, lot_no, expiry_date, delivered_qty, returned_qty, " +
  "invoiced_qty, credited_other_qty, line_returned_qty, returnable_qty";

export async function listReturns(filter: StatusFilter, orderId: string | null = null): Promise<Result<ReturnRow[]>> {
  const db = await createClient();
  let query = db.from("v_returns").select(RETURN_COLUMNS);
  const statuses = STATUS_FILTERS[filter];
  if (statuses.length > 0) query = query.in("status", [...statuses]);
  if (orderId) query = query.eq("order_id", orderId);
  return run("v_returns", query.order("created_at", { ascending: false }).limit(LIST_LIMIT), [] as ReturnRow[]);
}

export async function getReturn(id: string): Promise<Result<ReturnRow | null>> {
  const db = await createClient();
  return run("v_returns", db.from("v_returns").select(RETURN_COLUMNS).eq("id", id).maybeSingle(), null);
}

export async function listReturnLines(returnId: string): Promise<Result<ReturnLineRow[]>> {
  const db = await createClient();
  return run(
    "v_return_lines",
    db.from("v_return_lines").select(LINE_COLUMNS).eq("return_id", returnId).order("line_no").order("lot_no"),
    [] as ReturnLineRow[],
  );
}

export async function listReturnableLines(orderId: string): Promise<Result<ReturnableLineRow[]>> {
  const db = await createClient();
  return run(
    "v_returnable_lines",
    db.from("v_returnable_lines").select(RETURNABLE_COLUMNS).eq("order_id", orderId).order("line_no").order("lot_no"),
    [] as ReturnableLineRow[],
  );
}

const ORDER_COLUMNS = "id, order_no, customer_id, customer_name, status, total, submitted_at, created_at";

export async function getReturnOrder(orderId: string): Promise<Result<ReturnOrderRow | null>> {
  const db = await createClient();
  return run("v_orders", db.from("v_orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle(), null);
}

/** Delivered orders the user can see, newest first: where a return can start. */
export async function listReturnableOrders(): Promise<Result<ReturnOrderRow[]>> {
  const db = await createClient();
  return run(
    "v_orders",
    db
      .from("v_orders")
      .select(ORDER_COLUMNS)
      .in("status", [...RETURNABLE_ORDER_STATUSES])
      .order("submitted_at", { ascending: false, nullsFirst: false })
      .limit(50),
    [] as ReturnOrderRow[],
  );
}

/** Active quarantine warehouses (the only ones api.receive_return accepts). */
export async function listQuarantineWarehouses(): Promise<Result<WarehouseOption[]>> {
  const db = await createClient();
  return run(
    "v_inventory_warehouses",
    db.from("v_inventory_warehouses").select("id, code, name").eq("kind", "quarantine").eq("is_active", true).order("code"),
    [] as WarehouseOption[],
  );
}

export async function listReturnCreditNotes(returnId: string): Promise<Result<ReturnCreditNoteRow[]>> {
  const db = await createClient();
  return run(
    "v_credit_notes",
    db
      .from("v_credit_notes")
      .select("id, credit_no, invoice_id, invoice_no, amount, tax_amount, total, issue_date")
      .eq("return_id", returnId)
      .order("credit_no"),
    [] as ReturnCreditNoteRow[],
  );
}
