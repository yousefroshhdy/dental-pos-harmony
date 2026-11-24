import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { cairoDayBounds } from "@/modules/field/logic";
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
