import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { CoverageFilter } from "./logic";
import type {
  CoverageRow,
  GeneratedPlan,
  PlanningCustomer,
  PlanningEmployee,
  PlanningSettings,
  PlanRow,
} from "./types";

/**
 * Planning reads. All go through the user's session: the views are security_invoker (RLS decides
 * what comes back) and the functions check permission and scope themselves.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "planning.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "planning.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const COVERAGE_LIMIT = 300;

const PLAN_COLUMNS =
  "id, employee_id, employee_name_en, employee_name_ar, customer_id, customer_no, customer_name, visit_class, " +
  "planned_for, week_start, day_of_week, status, verification_status, check_in_at, check_out_at, outcome, " +
  // "Remove" is offered only when the caller may remove it (who planned it counts), not just when its state allows it.
  "can_unplan:may_unplan, is_missed, created_at";
const COVERAGE_COLUMNS =
  "customer_id, customer_no, customer_name, territory_id, lifecycle_stage, employee_id, employee_name_en, " +
  "employee_name_ar, visit_class, class_is_default, interval_days, period_start, period_end, target_visits, " +
  "actual_visits, target_met, last_visit_on, days_since_last_visit, next_due_on, is_overdue, overdue_days, next_planned_on";

export async function getPlanningSettings(): Promise<Result<PlanningSettings>> {
  const db = await createClient();
  return run("planning_settings", db.rpc("planning_settings"), null as unknown as PlanningSettings);
}

/** Who the caller can plan for (api.v_planning_employees). */
export async function listPlanningEmployees(): Promise<Result<PlanningEmployee[]>> {
  const db = await createClient();
  return run(
    "v_planning_employees",
    db.from("v_planning_employees").select("id, employee_no, full_name_en, full_name_ar, job_title, is_me").order("employee_no"),
    [],
  );
}

/** One employee's planned visits from `from` to `to` (inclusive). */
export async function listPlan(employeeId: string, from: string, to: string): Promise<Result<PlanRow[]>> {
  const db = await createClient();
  return run(
    "v_visit_plan",
    db
      .from("v_visit_plan")
      .select(PLAN_COLUMNS)
      .eq("employee_id", employeeId)
      .gte("planned_for", from)
      .lte("planned_for", to)
      .order("planned_for")
      .limit(500),
    [],
  );
}

/** Customers assigned to the employee that the caller can see (the add-visit picker). */
export async function listPlanningCustomers(employeeId: string): Promise<Result<PlanningCustomer[]>> {
  const db = await createClient();
  return run(
    "v_planning_customers",
    db
      .from("v_planning_customers")
      .select("employee_id, customer_id, assignment_role, customer_no, customer_name, lifecycle_stage, visit_class")
      .eq("employee_id", employeeId)
      .order("customer_name")
      .limit(1000),
    [],
  );
}

/** A proposal for one month (api.generate_plan writes nothing). */
export async function generatePlan(employeeId: string, monthFirstDay: string): Promise<Result<GeneratedPlan>> {
  const db = await createClient();
  return run(
    "generate_plan",
    db.rpc("generate_plan", { p_employee_id: employeeId, p_month: monthFirstDay }),
    null as unknown as GeneratedPlan,
  );
}

/** This month's coverage (api.v_coverage), optionally for one rep and overdue customers only. */
export async function listCoverage(opts: { employeeId?: string; filter: CoverageFilter }): Promise<Result<CoverageRow[]>> {
  const db = await createClient();
  let query = db.from("v_coverage").select(COVERAGE_COLUMNS);
  if (opts.employeeId) query = query.eq("employee_id", opts.employeeId);
  if (opts.filter === "overdue") query = query.eq("is_overdue", true);
  return run(
    "v_coverage",
    query.order("overdue_days", { ascending: false, nullsFirst: true }).order("customer_name").limit(COVERAGE_LIMIT),
    [],
  );
}
