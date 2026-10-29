import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { customerSearchFilter, pageRange, PAGE_SIZE } from "./logic";
import type { CustomerListParams } from "./schemas";
import type {
  CustomerListRow,
  CustomerRow,
  EmployeeOption,
  GovernorateRow,
  OpportunityRow,
  SpecialtyRow,
  TerritoryRow,
  TimelineRow,
} from "./types";

/**
 * CRM reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides which customers and opportunities come back.
 */

// No generated DB types yet; rows are cast to the view shapes in types.ts.
type QueryResult = { data: unknown; error: { code?: string; message?: string; details?: string } | null; count?: number | null };
type Query = PromiseLike<QueryResult>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<{ rows: T; count: number | null }>> {
  try {
    const { data, error, count } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "crm.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok({ rows: (data ?? empty) as T, count: count ?? null });
  } catch (cause) {
    log("error", "crm.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

async function rows<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  const result = await run(name, query, empty);
  return result.ok ? ok(result.data.rows) : result;
}

const LIST_COLUMNS =
  "id, customer_no, display_name, doctor_name, lifecycle_stage, specialty_code, phone_primary, city, governorate_code, " +
  "territory_name_en, territory_name_ar, primary_rep_name_en, primary_rep_name_ar, location_verified, latitude";

const DETAIL_COLUMNS =
  "id, customer_no, kind, doctor_name, clinic_name, display_name, specialty_code, lifecycle_stage, source, phone_primary, " +
  "phone_secondary, email, address_line, city, governorate_code, territory_id, territory_code, territory_name_en, " +
  "territory_name_ar, latitude, longitude, location_verified, tags, notes, version, primary_rep_employee_id, " +
  "primary_rep_name_en, primary_rep_name_ar, balance, balance_updated_at, credit_limit, payment_terms_days, created_at, " +
  "updated_at, archived_at";

const OPPORTUNITY_COLUMNS =
  "id, customer_id, customer_no, customer_name, title, brand_id, brand_code, brand_name, stage, expected_value, " +
  "probability_pct, expected_close_date, lost_reason, won_order_id, owner_employee_id, owner_name_en, owner_name_ar, " +
  "created_at, updated_at, closed_at";

export interface CustomerPage {
  rows: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Active (not archived) customers matching the filters, one page at a time. */
export async function listCustomers(params: CustomerListParams): Promise<Result<CustomerPage>> {
  const db = await createClient();
  const { from, to } = pageRange(params.page);
  let query = db.from("v_customers").select(LIST_COLUMNS, { count: "exact" }).is("archived_at", null);
  const search = customerSearchFilter(params.q);
  if (search) query = query.or(search);
  if (params.stage) query = query.eq("lifecycle_stage", params.stage);
  if (params.territory) query = query.eq("territory_id", params.territory);
  if (params.specialty) query = query.eq("specialty_code", params.specialty);
  const result = await run<CustomerListRow[]>(
    "v_customers",
    query.order("display_name", { ascending: true }).order("id", { ascending: true }).range(from, to),
    [],
  );
  if (!result.ok) return result;
  return ok({ rows: result.data.rows, total: result.data.count ?? result.data.rows.length, page: params.page, pageSize: PAGE_SIZE });
}

export async function getCustomer(customerId: string): Promise<Result<CustomerRow | null>> {
  const db = await createClient();
  return rows<CustomerRow | null>("v_customers", db.from("v_customers").select(DETAIL_COLUMNS).eq("id", customerId).maybeSingle(), null);
}

/** Customers to pick from when starting an opportunity (search by name, number or phone). */
export async function searchCustomers(term: string | undefined, limit = 20): Promise<Result<CustomerListRow[]>> {
  const db = await createClient();
  let query = db.from("v_customers").select(LIST_COLUMNS).is("archived_at", null);
  const search = customerSearchFilter(term);
  if (search) query = query.or(search);
  return rows<CustomerListRow[]>("v_customers", query.order("display_name").limit(limit), []);
}

export async function listTimeline(customerId: string, limit = 50): Promise<Result<TimelineRow[]>> {
  const db = await createClient();
  return rows<TimelineRow[]>(
    "v_customer_timeline",
    db
      .from("v_customer_timeline")
      .select("id, customer_id, type, occurred_at, summary, employee_id, employee_name_en, employee_name_ar, ref_table, ref_id, created_at")
      .eq("customer_id", customerId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit),
    [],
  );
}

/** Open opportunities plus those closed in the last `closedDays` days. */
export async function listOpportunities(opts: { customerId?: string; closedDays?: number } = {}): Promise<Result<OpportunityRow[]>> {
  const db = await createClient();
  const since = new Date(Date.now() - (opts.closedDays ?? 30) * 86_400_000).toISOString();
  let query = db.from("v_opportunities").select(OPPORTUNITY_COLUMNS).or(`closed_at.is.null,closed_at.gte."${since}"`);
  if (opts.customerId) query = query.eq("customer_id", opts.customerId);
  return rows<OpportunityRow[]>(
    "v_opportunities",
    query.order("updated_at", { ascending: false }).limit(500),
    [],
  );
}

export async function listGovernorates(): Promise<Result<GovernorateRow[]>> {
  const db = await createClient();
  return rows<GovernorateRow[]>("v_governorates", db.from("v_governorates").select("code, name_en, name_ar").order("name_en"), []);
}

export async function listSpecialties(): Promise<Result<SpecialtyRow[]>> {
  const db = await createClient();
  return rows<SpecialtyRow[]>("v_specialties", db.from("v_specialties").select("code, name_en, name_ar").order("name_en"), []);
}

export async function listTerritories(): Promise<Result<TerritoryRow[]>> {
  const db = await createClient();
  return rows<TerritoryRow[]>(
    "v_territories",
    db.from("v_territories").select("id, code, name_en, name_ar").eq("is_active", true).order("code"),
    [],
  );
}

export async function listAssignableEmployees(): Promise<Result<EmployeeOption[]>> {
  const db = await createClient();
  return rows<EmployeeOption[]>(
    "v_crm_assignable_employees",
    db.from("v_crm_assignable_employees").select("id, employee_no, full_name_en, full_name_ar, job_title").order("full_name_en"),
    [],
  );
}
