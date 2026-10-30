import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { BRAND_CODES, TEAM_CODES, TERRITORY_CODES } from "./logic";
import type { BreakdownRow, KpiRow, KpiTargetRow, Option, OverdueCustomerRow, PendingApprovalRow, Period, TeamRow } from "./types";

/**
 * Dashboard reads, all as the signed-in user. The api.kpi_* functions derive the
 * caller's scope from perf.kpi.read in Postgres (a rep: own figures, an area manager:
 * the team, the director/owner: everyone); the views apply RLS.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "dashboards.read_failed", { source: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "dashboards.read_failed", { source: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export async function getKpiSummary(period: Period, employeeId: string | null = null): Promise<Result<KpiRow[]>> {
  const db = await createClient();
  return run("kpi_summary", db.rpc("kpi_summary", { p_from: period.from, p_to: period.to, p_employee_id: employeeId }), []);
}

export async function getKpiTeam(period: Period): Promise<Result<TeamRow[]>> {
  const db = await createClient();
  return run("kpi_team", db.rpc("kpi_team", { p_from: period.from, p_to: period.to, p_codes: [...TEAM_CODES] }), []);
}

export async function getKpiBreakdown(period: Period, dimension: "territory" | "brand"): Promise<Result<BreakdownRow[]>> {
  const db = await createClient();
  const codes = dimension === "territory" ? [...TERRITORY_CODES] : [...BRAND_CODES];
  return run(
    `kpi_breakdown:${dimension}`,
    db.rpc("kpi_breakdown", { p_from: period.from, p_to: period.to, p_dimension: dimension, p_codes: codes }),
    [],
  );
}

export const OVERDUE_LIMIT = 10;

/** Overdue customers as of the period end (capped at today in the DB). */
export async function getOverdueCustomers(asOf: string, employeeId: string | null = null): Promise<Result<OverdueCustomerRow[]>> {
  const db = await createClient();
  return run(
    "kpi_overdue_customers",
    db.rpc("kpi_overdue_customers", { p_as_of: asOf, p_employee_id: employeeId, p_limit: OVERDUE_LIMIT }),
    [],
  );
}

export const PENDING_LIMIT = 8;

/** Approval requests waiting for the caller's decision (api.v_approval_requests, caller-scoped). */
export async function getPendingForMe(): Promise<Result<PendingApprovalRow[]>> {
  const db = await createClient();
  return run(
    "v_approval_requests",
    db
      .from("v_approval_requests")
      .select("request_id, workflow_code, workflow_name, created_at, subject_name_en, subject_name_ar, customer_name")
      .eq("status", "pending")
      .eq("can_decide", true)
      .order("created_at", { ascending: true })
      .limit(PENDING_LIMIT),
    [],
  );
}

export const TARGET_LIST_LIMIT = 100;

export async function listTargets(): Promise<Result<KpiTargetRow[]>> {
  const db = await createClient();
  return run(
    "v_kpi_targets",
    db
      .from("v_kpi_targets")
      .select(
        "id, kpi_code, unit, employee_id, employee_name_en, employee_name_ar, role_id, role_code, role_name_en, role_name_ar, " +
          "territory_id, territory_code, territory_name_en, territory_name_ar, target_value, period_start, period_end, created_at",
      )
      .order("period_start", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(TARGET_LIST_LIMIT),
    [],
  );
}

/** Options for the target form; RLS limits employees to the caller's read scope. */
export async function listTargetSubjects(): Promise<Result<{ employees: Option[]; roles: Option[]; territories: Option[] }>> {
  const db = await createClient();
  const [employees, roles, territories] = await Promise.all([
    run<{ id: string; full_name_en: string; full_name_ar: string | null }[]>(
      "v_employees",
      db.from("v_employees").select("id, full_name_en, full_name_ar").in("employment_status", ["active", "on_leave"]).order("full_name_en"),
      [],
    ),
    run<{ id: string; name_en: string; name_ar: string | null }[]>(
      "v_roles",
      db.from("v_roles").select("id, name_en, name_ar").eq("is_active", true).eq("is_owner_role", false).order("name_en"),
      [],
    ),
    run<{ id: string; name_en: string; name_ar: string | null }[]>(
      "v_territories",
      db.from("v_territories").select("id, name_en, name_ar").eq("is_active", true).order("name_en"),
      [],
    ),
  ]);
  if (!employees.ok) return employees;
  if (!roles.ok) return roles;
  if (!territories.ok) return territories;
  return ok({
    employees: employees.data.map((e) => ({ id: e.id, label_en: e.full_name_en, label_ar: e.full_name_ar })),
    roles: roles.data.map((r) => ({ id: r.id, label_en: r.name_en, label_ar: r.name_ar })),
    territories: territories.data.map((t) => ({ id: t.id, label_en: t.name_en, label_ar: t.name_ar })),
  });
}
