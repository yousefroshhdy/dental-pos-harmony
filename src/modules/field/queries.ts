import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { cairoDayBounds, sanitizeSearch, type TaskFilters } from "./logic";
import type { CustomerPick, TaskRow, TodayItem, VisitRow, VisitStatus } from "./types";

/**
 * Field and task reads. All go through the user's session against api.v_*
 * views (security_invoker), so RLS decides what comes back.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "field.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "field.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const LIST_LIMIT = 100;

const TODAY_COLUMNS = "item_type, item_id, title, kind, priority, status, customer_id, customer_name, due_at, planned_for, is_overdue";
const VISIT_COLUMNS =
  "id, customer_id, customer_no, customer_name, employee_id, employee_name_en, employee_name_ar, planned_for, status, " +
  "check_in_at, check_in_received_at, check_in_distance_m, check_in_accuracy_m, check_out_at, verification_status, " +
  "anomaly_flags, outcome, notes, created_at, updated_at";
const TASK_COLUMNS =
  "id, title, description, kind, priority, status, due_at, completed_at, outcome, source, ref_table, ref_id, " +
  "customer_id, customer_no, customer_name, assignee_employee_id, assignee_name_en, assignee_name_ar, is_overdue, created_at";

/** The caller's day (api.v_my_today: the view filters to the caller and the Cairo date). */
export async function listMyToday(): Promise<Result<TodayItem[]>> {
  const db = await createClient();
  return run("v_my_today", db.from("v_my_today").select(TODAY_COLUMNS).order("due_at", { ascending: true, nullsFirst: false }), []);
}

export async function listVisits(opts: { employeeId?: string; status?: VisitStatus }): Promise<Result<VisitRow[]>> {
  const db = await createClient();
  let query = db.from("v_visits").select(VISIT_COLUMNS);
  if (opts.employeeId) query = query.eq("employee_id", opts.employeeId);
  if (opts.status) query = query.eq("status", opts.status);
  return run(
    "v_visits",
    query
      .order("check_in_at", { ascending: false, nullsFirst: true })
      .order("planned_for", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT),
    [],
  );
}

export async function getVisit(visitId: string): Promise<Result<VisitRow | null>> {
  const db = await createClient();
  return run("v_visits", db.from("v_visits").select(VISIT_COLUMNS).eq("id", visitId).maybeSingle(), null);
}

export async function listTasks(filters: TaskFilters, employeeId: string | null, now: Date = new Date()): Promise<Result<TaskRow[]>> {
  const db = await createClient();
  let query = db.from("v_tasks").select(TASK_COLUMNS).eq("status", filters.status);
  if (filters.who === "mine") {
    // No employee profile → no tasks of one's own; RLS would return none anyway.
    if (!employeeId) return ok([]);
    query = query.eq("assignee_employee_id", employeeId);
  }
  if (filters.due === "today") {
    const { start, end } = cairoDayBounds(now);
    query = query.gte("due_at", start.toISOString()).lt("due_at", end.toISOString());
  } else if (filters.due === "overdue") {
    query = query.eq("is_overdue", true);
  }
  const ascending = filters.status === "open";
  return run(
    "v_tasks",
    query
      .order(filters.status === "open" ? "due_at" : "completed_at", { ascending, nullsFirst: false })
      .limit(LIST_LIMIT),
    [],
  );
}

/** Customers in the caller's scope for an unplanned check-in (RLS limits rows to assigned/territory customers). */
export async function searchCustomers(q: string): Promise<Result<CustomerPick[]>> {
  const term = sanitizeSearch(q);
  const db = await createClient();
  let query = db.from("v_customers").select("id, customer_no, display_name, city, location_verified").is("archived_at", null);
  if (term) query = query.or(`display_name.ilike.*${term}*,customer_no.ilike.*${term}*`);
  return run("v_customers", query.order("display_name").limit(20), []);
}

export async function getCustomer(customerId: string): Promise<Result<CustomerPick | null>> {
  const db = await createClient();
  return run(
    "v_customers",
    db.from("v_customers").select("id, customer_no, display_name, city, location_verified").eq("id", customerId).maybeSingle(),
    null,
  );
}
