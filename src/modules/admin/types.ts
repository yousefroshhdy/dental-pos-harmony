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

/** Result of an admin Server Action. Only a translatable key and a request id reach the browser. */
export type ActionResult = { ok: true } | { ok: false; messageKey: TranslatedCode; requestId?: string };
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
