import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type {
  AdminEmployeeRow,
  CoverageRow,
  EmployeeTerritoryRow,
  GovernorateRow,
  HeldCustomerRow,
  OrgUnitRow,
  PermissionRow,
  RolePermissionRow,
  RoleRow,
  SecurityEventRow,
  SettingRow,
  TerritoryCountRow,
  TerritoryRow,
  UserRoleRow,
  UserRow,
} from "./types";

/**
 * Admin console reads. All go through the user's session against api.v_*
 * views (security_invoker), so RLS decides what comes back.
 */

// No generated DB types yet (Phase 2 adds `supabase gen types`); rows are cast to the view shapes in types.ts.
type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "admin.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "admin.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const USER_COLUMNS =
  "user_id, status, locale, suspended_at, created_at, employee_id, employee_no, full_name_en, full_name_ar, job_title, employment_status, email";
const ROLE_COLUMNS = "id, code, name_en, name_ar, description, is_system, is_owner_role, is_active, permission_count";
const USER_ROLE_COLUMNS =
  "id, user_id, role_id, role_code, role_name_en, scope_territory_id, scope_warehouse_id, valid_from, valid_to, granted_at, revoked_at";

export async function listUsers(): Promise<Result<UserRow[]>> {
  const db = await createClient();
  return run("v_users", db.from("v_users").select(USER_COLUMNS).order("employee_no", { ascending: true, nullsFirst: false }), []);
}

export async function getUser(userId: string): Promise<Result<UserRow | null>> {
  const db = await createClient();
  return run("v_users", db.from("v_users").select(USER_COLUMNS).eq("user_id", userId).maybeSingle(), null);
}

/** Assignments not yet revoked (validity window is checked in logic.isActiveAssignment). */
export async function listOpenAssignments(userId?: string): Promise<Result<UserRoleRow[]>> {
  const db = await createClient();
  let query = db.from("v_user_roles").select(USER_ROLE_COLUMNS).is("revoked_at", null);
  if (userId) query = query.eq("user_id", userId);
  return run("v_user_roles", query.order("granted_at", { ascending: true }), []);
}

export async function listRoles(): Promise<Result<RoleRow[]>> {
  const db = await createClient();
  return run("v_roles", db.from("v_roles").select(ROLE_COLUMNS).order("code"), []);
}

export async function getRole(roleId: string): Promise<Result<RoleRow | null>> {
  const db = await createClient();
  return run("v_roles", db.from("v_roles").select(ROLE_COLUMNS).eq("id", roleId).maybeSingle(), null);
}

export async function listPermissions(): Promise<Result<PermissionRow[]>> {
  const db = await createClient();
  return run(
    "v_permissions",
    db.from("v_permissions").select("code, module, description, allowed_scopes, supports_limit, is_sensitive").order("code"),
    [],
  );
}

export async function listRolePermissions(roleId: string): Promise<Result<RolePermissionRow[]>> {
  const db = await createClient();
  return run(
    "v_role_permissions",
    db.from("v_role_permissions").select("role_id, permission_code, scope, limit_value").eq("role_id", roleId),
    [],
  );
}

export async function listTerritories(): Promise<Result<TerritoryRow[]>> {
  const db = await createClient();
  return run(
    "v_territories",
    db.from("v_territories").select("id, code, name_en, name_ar, parent_id, level, is_active").eq("is_active", true).order("code"),
    [],
  );
}

export async function listSecurityEvents(limit = 200): Promise<Result<SecurityEventRow[]>> {
  const db = await createClient();
  return run(
    "v_security_events",
    db
      .from("v_security_events")
      .select("id, occurred_at, user_id, event_type, severity, details")
      .order("occurred_at", { ascending: false })
      .limit(limit)
      ,
    [],
  );
}

// ---------------------------------------------------------------------------
// Admin console v2 (migrations 20261103000800–0820)
// ---------------------------------------------------------------------------

const SETTING_COLUMNS =
  "key, group_code, value_type, min_value, max_value, allowed_values, default_value, unit, owner_only, is_editable, is_whitelisted, label_en, label_ar, description_en, description_ar, value, is_default, updated_at, updated_by, sort_order";

export async function listSettings(): Promise<Result<SettingRow[]>> {
  const db = await createClient();
  return run("v_settings", db.from("v_settings").select(SETTING_COLUMNS).order("group_code").order("sort_order"), []);
}

const EMPLOYEE_COLUMNS =
  "id, employee_no, user_id, full_name_en, full_name_ar, job_title, phone, email, department_id, department_code, department_name_en, department_name_ar, office_id, office_code, office_name_en, office_name_ar, manager_id, manager_no, manager_name_en, manager_name_ar, employment_status, hired_on, terminated_on, created_at, updated_at, direct_reports";

export async function listEmployees(): Promise<Result<AdminEmployeeRow[]>> {
  const db = await createClient();
  return run("v_admin_employees", db.from("v_admin_employees").select(EMPLOYEE_COLUMNS).order("employee_no"), []);
}

export async function getEmployee(employeeId: string): Promise<Result<AdminEmployeeRow | null>> {
  const db = await createClient();
  return run("v_admin_employees", db.from("v_admin_employees").select(EMPLOYEE_COLUMNS).eq("id", employeeId).maybeSingle(), null);
}

const EMPLOYEE_TERRITORY_COLUMNS =
  "id, employee_id, territory_id, territory_code, territory_name_en, territory_name_ar, territory_active, assignment, valid_from, valid_to";

/** Open (current) territory assignments, optionally for one employee. */
export async function listOpenEmployeeTerritories(employeeId?: string): Promise<Result<EmployeeTerritoryRow[]>> {
  const db = await createClient();
  let query = db.from("v_employee_territories").select(EMPLOYEE_TERRITORY_COLUMNS).is("valid_to", null);
  if (employeeId) query = query.eq("employee_id", employeeId);
  return run("v_employee_territories", query.order("territory_code"), []);
}

export async function listDepartments(): Promise<Result<OrgUnitRow[]>> {
  const db = await createClient();
  return run("v_departments", db.from("v_departments").select("id, code, name_en, name_ar, is_active").order("code"), []);
}

export async function listOffices(): Promise<Result<OrgUnitRow[]>> {
  const db = await createClient();
  return run("v_offices", db.from("v_offices").select("id, code, name_en, name_ar, is_active").order("code"), []);
}

/** Customers the employee holds (a definer read: works without CRM access, minimal columns). */
export async function listHeldCustomers(employeeId: string): Promise<Result<HeldCustomerRow[]>> {
  const db = await createClient();
  return run("employee_customer_holdings", db.rpc("employee_customer_holdings", { p_employee_id: employeeId }), []);
}

/** Every territory, active or not (the admin tree shows both). */
export async function listAllTerritories(): Promise<Result<TerritoryRow[]>> {
  const db = await createClient();
  return run("v_territories", db.from("v_territories").select("id, code, name_en, name_ar, parent_id, level, is_active").order("code"), []);
}

export async function listTerritoryCounts(): Promise<Result<TerritoryCountRow[]>> {
  const db = await createClient();
  return run("territory_customer_counts", db.rpc("territory_customer_counts"), []);
}

export async function listCoverage(): Promise<Result<CoverageRow[]>> {
  const db = await createClient();
  return run(
    "v_territory_coverage",
    db
      .from("v_territory_coverage")
      .select(
        "territory_id, territory_code, territory_name_en, territory_name_ar, territory_active, governorate_code, governorate_name_en, governorate_name_ar, city",
      )
      .order("governorate_code")
      .order("city"),
    [],
  );
}

export async function listGovernorates(): Promise<Result<GovernorateRow[]>> {
  const db = await createClient();
  return run("v_governorates", db.from("v_governorates").select("code, name_en, name_ar").order("code"), []);
}
