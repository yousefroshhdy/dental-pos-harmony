import type { TranslatedCode } from "@/lib/errors";

/** Row shapes of the api.v_* views used by the admin console (supabase/migrations/…_platform_admin.sql). */

export type ProfileStatus = "active" | "suspended" | "disabled";
export type Severity = "info" | "warning" | "critical";

export interface UserRow {
  user_id: string;
  status: ProfileStatus;
  locale: "ar" | "en";
  suspended_at: string | null;
  created_at: string;
  employee_id: string | null;
  employee_no: string | null;
  full_name_en: string | null;
  full_name_ar: string | null;
  job_title: string | null;
  employment_status: string | null;
  email: string | null;
}

export interface RoleRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  is_system: boolean;
  is_owner_role: boolean;
  is_active: boolean;
  permission_count: number;
}

export interface UserRoleRow {
  id: string;
  user_id: string;
  role_id: string;
  role_code: string;
  role_name_en: string;
  scope_territory_id: string | null;
  scope_warehouse_id: string | null;
  valid_from: string;
  valid_to: string | null;
  granted_at: string;
  revoked_at: string | null;
}

export interface PermissionRow {
  code: string;
  module: string;
  description: string;
  allowed_scopes: string[];
  supports_limit: boolean;
  is_sensitive: boolean;
}

export interface RolePermissionRow {
  role_id: string;
  permission_code: string;
  scope: string;
  /** numeric(14,2): PostgREST may send a number or a string. */
  limit_value: number | string | null;
}

export interface TerritoryRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  parent_id: string | null;
  level: string | null;
  is_active: boolean;
}

export interface SecurityEventRow {
  id: string;
  occurred_at: string;
  user_id: string | null;
  event_type: string;
  severity: Severity;
  details: unknown;
}

/**
 * Business codes raised by the admin v2 commands that have no generic errors.* text.
 * They are translated under admin.errors.* (see ADMIN_ERROR_CODES in logic.ts).
 */
export type AdminErrorCode =
  | "MANAGER_CYCLE"
  | "TERRITORY_CYCLE"
  | "TERRITORY_TOO_DEEP"
  | "TERRITORY_HAS_CHILDREN"
  | "SETTING_NOT_WHITELISTED"
  | "SETTING_READ_ONLY"
  | "SETTING_OUT_OF_RANGE"
  | "SETTING_SECRET_REFUSED";

/** Result of an admin Server Action. Only a translatable key and a request id reach the browser. */
export type ActionResult = { ok: true } | { ok: false; messageKey: TranslatedCode; requestId?: string; adminCode?: AdminErrorCode };
/** `null` = the form has not been submitted yet (useActionState initial state). */
export type ActionState = ActionResult | null;

/** Where the invite flow stopped (see inviteUser in actions.ts). */
export type InviteStage = "input" | "permission" | "employee" | "invite" | "link";

export type InviteState = null | {
  ok: false;
  stage: InviteStage;
  messageKey: TranslatedCode;
  requestId?: string;
  /** Set once the employee record exists, so a retry skips creating it again. */
  employeeId?: string;
  /** Set once the Auth user exists, so a retry only re-runs api.register_user. */
  userId?: string;
  invalidFields?: string[];
  /** What the admin typed (never anything from the service client), to refill the form. */
  values?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Admin console v2 (supabase/migrations/20261103000800–0820)
// ---------------------------------------------------------------------------

export type SettingValueType = "integer" | "number" | "boolean" | "text" | "enum" | "enum_array" | "time_range";

/** api.v_settings */
export interface SettingRow {
  key: string;
  group_code: string;
  value_type: SettingValueType | null;
  /** numeric: PostgREST may send a number or a string. */
  min_value: number | string | null;
  max_value: number | string | null;
  allowed_values: string[] | null;
  default_value: unknown;
  unit: string | null;
  owner_only: boolean;
  is_editable: boolean;
  is_whitelisted: boolean;
  label_en: string | null;
  label_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  value: unknown;
  is_default: boolean;
  updated_at: string | null;
  updated_by: string | null;
  sort_order: number;
}

export type EmploymentStatus = "active" | "on_leave" | "suspended" | "terminated";

/** api.v_admin_employees */
export interface AdminEmployeeRow {
  id: string;
  employee_no: string;
  user_id: string | null;
  full_name_en: string;
  full_name_ar: string | null;
  job_title: string;
  phone: string | null;
  email: string | null;
  department_id: string | null;
  department_code: string | null;
  department_name_en: string | null;
  department_name_ar: string | null;
  office_id: string | null;
  office_code: string | null;
  office_name_en: string | null;
  office_name_ar: string | null;
  manager_id: string | null;
  manager_no: string | null;
  manager_name_en: string | null;
  manager_name_ar: string | null;
  employment_status: EmploymentStatus;
  hired_on: string | null;
  terminated_on: string | null;
  created_at: string;
  updated_at: string;
  direct_reports: number;
}

/** api.v_employee_territories */
export interface EmployeeTerritoryRow {
  id: string;
  employee_id: string;
  territory_id: string;
  territory_code: string;
  territory_name_en: string;
  territory_name_ar: string | null;
  territory_active: boolean;
  assignment: "member" | "manager";
  valid_from: string;
  valid_to: string | null;
}

/** api.v_departments / api.v_offices */
export interface OrgUnitRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  is_active: boolean;
}

/** api.employee_customer_holdings() */
export interface HeldCustomerRow {
  customer_id: string;
  customer_no: string;
  display_name: string;
  role: string;
  lifecycle_stage: string;
  territory_code: string | null;
  assigned_since: string;
}

/** api.v_territory_coverage */
export interface CoverageRow {
  territory_id: string;
  territory_code: string;
  territory_name_en: string;
  territory_name_ar: string | null;
  territory_active: boolean;
  governorate_code: string;
  governorate_name_en: string;
  governorate_name_ar: string;
  city: string;
}

/** api.territory_customer_counts(); territory_id NULL = customers without a territory. */
export interface TerritoryCountRow {
  territory_id: string | null;
  customers: number;
  active_customers: number;
  leads: number;
  employees: number;
}

/** api.v_governorates */
export interface GovernorateRow {
  code: string;
  name_en: string;
  name_ar: string;
}
