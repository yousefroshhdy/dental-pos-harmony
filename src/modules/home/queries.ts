import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { cairoDayBounds } from "@/modules/field/logic";
import type { TodoKey } from "./todo";
import type { AgingTotals, OpportunityLite, PlanItem, ReceiptRow, VisitToday } from "./types";

/**
 * Role-home reads, all as the signed-in user against existing api.* views
 * (security_invoker, so RLS decides what comes back). KPI figures and the approvals
 * list reuse the dashboards module's queries (src/modules/dashboards/queries.ts).
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "home.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "home.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const PLAN_LIMIT = 8;

/** The caller's planned and in-progress visits today (api.v_my_today filters to the caller and the Cairo date). */
export async function listPlanToday(): Promise<Result<PlanItem[]>> {
  const db = await createClient();
  return run(
    "v_my_today",
    db
      .from("v_my_today")
      .select("item_type, item_id, title, status, customer_id, customer_name, due_at, planned_for, is_overdue")
      .eq("item_type", "visit")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(PLAN_LIMIT),
    [],
  );
}

/** One employee's visits checked in today (Cairo day). */
export async function listVisitsToday(employeeId: string, now: Date = new Date()): Promise<Result<VisitToday[]>> {
  const db = await createClient();
  const { start, end } = cairoDayBounds(now);
  return run(
    "v_visits",
    db
      .from("v_visits")
      .select("id, customer_id, customer_name, status, check_in_at, check_out_at, verification_status")
      .eq("employee_id", employeeId)
      .gte("check_in_at", start.toISOString())
      .lt("check_in_at", end.toISOString())
      .order("check_in_at", { ascending: false })
      .limit(20),
    [],
  );
}

/** Receipts received today (Cairo day) that the caller may see. */
export async function listReceiptsToday(now: Date = new Date()): Promise<Result<ReceiptRow[]>> {
  const db = await createClient();
  const { start, end } = cairoDayBounds(now);
  return run(
    "v_payments",
    db
      .from("v_payments")
      .select("id, amount, status, method")
      .gte("received_at", start.toISOString())
      .lt("received_at", end.toISOString())
      .limit(1000),
    [],
  );
}

export async function getAgingTotals(): Promise<Result<AgingTotals | null>> {
  const db = await createClient();
  return run(
    "v_ar_aging_totals",
    db.from("v_ar_aging_totals").select("customers, current_amount, d1_30, d31_60, d61_90, d90_plus, total_open, overdue_amount").maybeSingle(),
    null,
  );
}

/** Open opportunities in the caller's scope (stage and value only). */
export async function listOpenOpportunities(): Promise<Result<OpportunityLite[]>> {
  const db = await createClient();
  return run("v_opportunities", db.from("v_opportunities").select("stage, expected_value").is("closed_at", null).limit(2000), []);
}

// ---------------------------------------------------------------------------
// To-do counts (src/modules/home/todo.ts): exact counts, no rows, existing api.* views
// ---------------------------------------------------------------------------

type CountQuery = PromiseLike<{ count: number | null; error: { code?: string; message?: string; details?: string } | null }>;

/** A head-only exact count as the caller; a failed read is `null`, never 0. */
async function countOf(name: string, query: CountQuery): Promise<number | null> {
  try {
    const { count, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "home.count_failed", { view: name, code: appError.code, detail: appError.detail });
      return null;
    }
    return count ?? 0;
  } catch (cause) {
    log("error", "home.count_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return null;
  }
}

const HEAD = { count: "exact", head: true } as const;

/** One count per to-do key, as the caller (RLS decides what is counted). */
export async function countTodo(key: TodoKey): Promise<number | null> {
  const db = await createClient();
  switch (key) {
    case "approvals":
      // The same rows as the approvals card (getPendingForMe), counted without its list limit.
      return countOf(
        "v_approval_requests",
        db.from("v_approval_requests").select("request_id", HEAD).eq("status", "pending").eq("can_decide", true),
      );
    case "planToday":
      // Planned and in-progress visits today (api.v_my_today is the caller's own Cairo day).
      return countOf("v_my_today", db.from("v_my_today").select("item_id", HEAD).eq("item_type", "visit"));
    case "tasksToday":
      return countOf("v_my_today", db.from("v_my_today").select("item_id", HEAD).eq("item_type", "task"));
    case "draftOrders":
      return countOf("v_orders", db.from("v_orders").select("id", HEAD).eq("status", "draft"));
    case "leadsNew":
      return countOf("v_leads", db.from("v_leads").select("id", HEAD).eq("status", "new"));
    case "repsNeedingAttention":
      return countOf("v_tracking_health", db.from("v_tracking_health").select("employee_id", HEAD).eq("needs_attention", true));
    case "paymentsToVerify":
      return countOf("v_payments", db.from("v_payments").select("id", HEAD).eq("status", "pending_verification"));
    case "ordersToInvoice":
      return countOf("v_invoiceable_orders", db.from("v_invoiceable_orders").select("order_id", HEAD));
    case "overdueInvoices":
      return countOf("v_invoices", db.from("v_invoices").select("id", HEAD).eq("is_overdue", true));
    case "returnsToCredit":
      return countOf("v_returns", db.from("v_returns").select("id", HEAD).eq("status", "received"));
    case "ordersToReserve":
      return countOf("v_orders", db.from("v_orders").select("id", HEAD).eq("status", "approved"));
    case "ordersToFulfil":
      return countOf("v_orders", db.from("v_orders").select("id", HEAD).in("status", ["reserved", "partially_fulfilled"]));
    case "returnsToReceive":
      return countOf("v_returns", db.from("v_returns").select("id", HEAD).eq("status", "approved"));
    case "draftReceipts":
      return countOf("v_goods_receipts", db.from("v_goods_receipts").select("id", HEAD).eq("status", "draft"));
    case "lowStock":
      return countOf("v_reorder_alerts", db.from("v_reorder_alerts").select("variant_id", HEAD));
  }
}
