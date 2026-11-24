import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { monthStart } from "./logic";
import type {
  AdjustmentRequestRow,
  EmployeeOption,
  PeriodRow,
  PlanRow,
  RuleRow,
  StatementLine,
  StatementTotalsRow,
  SummaryRow,
  TargetOption,
  UnratedRow,
} from "./types";

/**
 * Commission reads, all as the signed-in user. RLS on perf.commission_* decides whose
 * lines come back (perf.commission.read: a rep their own, an area manager the team,
 * finance, the sales director and the owner everyone); the views are security_invoker.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "commissions.read_failed", { source: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "commissions.read_failed", { source: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const STATEMENT_LIMIT = 500;

/** One employee's statement lines for one month (entries and approved adjustments). */
export async function getStatement(month: string, employeeId: string): Promise<Result<StatementLine[]>> {
  const db = await createClient();
  return run(
    "v_commission_statement",
    db
      .from("v_commission_statement")
      .select(
        "line_type, id, period_start, period_status, employee_id, kind, source_type, invoice_id, invoice_no, order_no, " +
          "customer_name, sku, description, document_no, base_amount, rate_pct, amount, event_at, event_date, reason",
      )
      .eq("period_start", monthStart(month))
      .eq("employee_id", employeeId)
      .order("event_at", { ascending: false })
      .order("id")
      .limit(STATEMENT_LIMIT),
    [],
  );
}

/** Per-employee totals of one month (every employee the caller may read). */
export async function getSummary(month: string, employeeId: string | null = null): Promise<Result<SummaryRow[]>> {
  const db = await createClient();
  let query = db
    .from("v_commission_summary")
    .select(
      "period_id, period_start, period_status, employee_id, employee_no, employee_name_en, employee_name_ar, " +
        "earned, clawed_back, adjustments, total, base_total, entry_count",
    )
    .eq("period_start", monthStart(month));
  if (employeeId) query = query.eq("employee_id", employeeId);
  return run("v_commission_summary", query.order("employee_name_en", { ascending: true, nullsFirst: false }).limit(500), []);
}

export async function getPeriod(month: string): Promise<Result<PeriodRow | null>> {
  const db = await createClient();
  return run(
    "v_commission_periods",
    db
      .from("v_commission_periods")
      .select("id, period_start, period_end, status, is_frozen, closes_at, calculated_at, closed_at, entries_total, entry_count, adjustments_total, total, employee_count")
      .eq("period_start", monthStart(month))
      .maybeSingle(),
    null,
  );
}

export const PERIOD_LIMIT = 36;

export async function listPeriods(): Promise<Result<PeriodRow[]>> {
  const db = await createClient();
  return run(
    "v_commission_periods",
    db
      .from("v_commission_periods")
      .select("id, period_start, period_end, status, is_frozen, closes_at, calculated_at, closed_at, entries_total, entry_count, adjustments_total, total, employee_count")
      .order("period_start", { ascending: false })
      .limit(PERIOD_LIMIT),
    [],
  );
}

export const REQUEST_LIMIT = 100;

export async function listAdjustmentRequests(): Promise<Result<AdjustmentRequestRow[]>> {
  const db = await createClient();
  return run(
    "v_commission_adjustment_requests",
    db
      .from("v_commission_adjustment_requests")
      .select(
        "request_id, adjustment_id, status, created_at, decided_at, is_mine, employee_id, employee_no, employee_name_en, " +
          "employee_name_ar, period_start, amount, kind, reason",
      )
      .order("created_at", { ascending: false })
      .limit(REQUEST_LIMIT),
    [],
  );
}

// ---------------------------------------------------------------------------
// Rep statement totals and the rate editor
// ---------------------------------------------------------------------------

/** Collected cash → commissionable → commission → clawbacks → net of one employee and month. */
export async function getStatementTotals(month: string, employeeId: string): Promise<Result<StatementTotalsRow | null>> {
  const db = await createClient();
  return run(
    "v_commission_statement_totals",
    db
      .from("v_commission_statement_totals")
      .select(
        "period_id, period_start, period_end, period_status, employee_id, employee_no, employee_name_en, employee_name_ar, " +
          "collected_gross, vat_amount, commissionable, unrated_base, commission, clawbacks, clawback_base, adjustments, net, entry_count",
      )
      .eq("period_start", monthStart(month))
      .eq("employee_id", employeeId)
      .maybeSingle(),
    null,
  );
}

const PLAN_COLUMNS =
  "id, code, name, basis, status, effective_from, effective_to, is_default, activated_at, retired_at, retire_reason, created_at, " +
  "current_rate_count, assigned_count";

export async function listPlans(): Promise<Result<PlanRow[]>> {
  const db = await createClient();
  return run("v_commission_plans", db.from("v_commission_plans").select(PLAN_COLUMNS).order("created_at", { ascending: false }).limit(100), []);
}

export async function getPlan(planId: string): Promise<Result<PlanRow | null>> {
  const db = await createClient();
  return run("v_commission_plans", db.from("v_commission_plans").select(PLAN_COLUMNS).eq("id", planId).maybeSingle(), null);
}

export const RULE_LIMIT = 1000;

export async function listPlanRules(planId: string): Promise<Result<RuleRow[]>> {
  const db = await createClient();
  return run(
    "v_commission_plan_rules",
    db
      .from("v_commission_plan_rules")
      .select(
        "id, plan_id, plan_code, target_type, target_id, target_code, target_name_en, target_name_ar, rate_pct, priority, " +
          "effective_from, effective_to, voided_at, note, created_at, state",
      )
      .eq("plan_id", planId)
      .order("created_at", { ascending: false })
      .limit(RULE_LIMIT),
    [],
  );
}

/** Products with no rate in the plan today: they earn 0 until the owner sets one. */
export async function listUnrated(planId: string): Promise<Result<UnratedRow[]>> {
  const db = await createClient();
  return run("commission_unrated", db.rpc("commission_unrated", { p_plan_id: planId }), []);
}

/** Brands, categories and products the rate form can target (catalog read views, RLS applies). */
export async function listRateTargets(locale: string): Promise<
  Result<{ brand: TargetOption[]; category: TargetOption[]; variant: TargetOption[] }>
> {
  const db = await createClient();
  const [brands, categories, variants] = await Promise.all([
    run<{ id: string; code: string; name: string }[]>(
      "v_catalog_brands",
      db.from("v_catalog_brands").select("id, code, name").eq("is_active", true).order("code").limit(500),
      [],
    ),
    run<{ id: string; code: string; name_en: string; name_ar: string }[]>(
      "v_catalog_categories",
      db.from("v_catalog_categories").select("id, code, name_en, name_ar").order("code").limit(500),
      [],
    ),
    run<{ id: string; sku: string; name_en: string; product_name_ar: string | null }[]>(
      "v_catalog_variants",
      db.from("v_catalog_variants").select("id, sku, name_en, product_name_ar").eq("status", "active").order("sku").limit(2000),
      [],
    ),
  ]);
  if (!brands.ok) return brands;
  if (!categories.ok) return categories;
  if (!variants.ok) return variants;
  return ok({
    brand: brands.data.map((b) => ({ id: b.id, label: `${b.name} (${b.code})` })),
    category: categories.data.map((c) => ({ id: c.id, label: `${locale === "ar" ? c.name_ar : c.name_en} (${c.code})` })),
    variant: variants.data.map((v) => ({ id: v.id, label: `${(locale === "ar" ? v.product_name_ar : null) ?? v.name_en} (${v.sku})` })),
  });
}

/** Employees the adjustment form may name (RLS on api.v_employees limits the list). */
export async function listAdjustableEmployees(locale: string, selfId: string | null): Promise<Result<EmployeeOption[]>> {
  const db = await createClient();
  const result = await run<{ id: string; full_name_en: string; full_name_ar: string | null; employee_no: string }[]>(
    "v_employees",
    db
      .from("v_employees")
      .select("id, full_name_en, full_name_ar, employee_no")
      .in("employment_status", ["active", "on_leave"])
      .order("full_name_en")
      .limit(500),
    [],
  );
  if (!result.ok) return result;
  return ok(
    result.data
      .filter((e) => e.id !== selfId)
      .map((e) => ({ id: e.id, label: `${(locale === "ar" ? e.full_name_ar : null) ?? e.full_name_en} (${e.employee_no})` })),
  );
}
