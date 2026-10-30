/**
 * Row shapes of the api.v_* views used by the workflow screens
 * (supabase/migrations/20261103001000_workflow_admin.sql) and the Server Action results.
 */

export type ApproverType = "permission" | "role" | "requester_manager" | "user";
export const APPROVER_TYPES: readonly ApproverType[] = ["permission", "role", "requester_manager", "user"];

export type DelegationStatus = "active" | "scheduled" | "ended" | "revoked";
export const DELEGATION_STATUSES: readonly DelegationStatus[] = ["active", "scheduled", "ended", "revoked"];

/** Operators of the condition language (wf.condition_matches). */
export const CONDITION_OPS = ["=", "!=", ">", ">=", "<", "<=", "in"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** How a clause value is typed in the editor; lists are for the "in" operator. */
export const VALUE_TYPES = ["number", "text", "boolean", "number_list", "text_list"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export type Scalar = number | string | boolean;
export interface ConditionClause {
  field: string;
  op: ConditionOp;
  value: Scalar | Scalar[];
}
/** `{}` = always; otherwise every clause must hold. */
export type Condition = Record<string, never> | { all: ConditionClause[] };

export interface DefinitionRow {
  id: string;
  code: string;
  name: string;
  entity_type: string;
  is_active: boolean;
  version: number;
  rule_count: number;
}

export interface RuleRow {
  rule_id: string;
  definition_id: string;
  workflow_code: string;
  priority: number;
  condition: unknown;
  auto_approve: boolean;
  is_catch_all: boolean;
  stage_count: number;
}

export interface StageRow {
  stage_id: string;
  rule_id: string;
  stage_no: number;
  approver_type: ApproverType;
  approver_permission: string | null;
  approver_role_id: string | null;
  approver_role_code: string | null;
  approver_role_name_en: string | null;
  approver_role_name_ar: string | null;
  approver_user_id: string | null;
  approver_user_name_en: string | null;
  approver_user_name_ar: string | null;
  required_approvals: number;
  escalate_after_minutes: number | null;
  escalate_to_user_id: string | null;
  escalate_to_name_en: string | null;
  escalate_to_name_ar: string | null;
}

export interface DelegationRow {
  id: string;
  from_user_id: string;
  from_name_en: string | null;
  from_name_ar: string | null;
  to_user_id: string;
  to_name_en: string | null;
  to_name_ar: string | null;
  definition_id: string | null;
  workflow_code: string | null;
  workflow_name: string | null;
  valid_from: string;
  valid_to: string;
  created_at: string;
  created_by: string | null;
  reason: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  status: DelegationStatus;
  is_from_me: boolean;
  is_to_me: boolean;
}

export interface EscalationRow {
  request_id: string;
  workflow_code: string;
  workflow_name: string;
  entity_type: string;
  entity_id: string;
  status: string;
  current_stage: number;
  stage_no: number;
  created_at: string;
  level: number;
  first_escalated_at: string;
  last_escalated_at: string;
  i_am_target: boolean;
  is_open: boolean;
  can_decide: boolean;
}

export interface PersonRow {
  user_id: string;
  employee_id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  job_title: string | null;
  in_delegation_scope: boolean;
}

export interface PermissionOption {
  code: string;
  description: string;
}

export interface RoleOption {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  is_active: boolean;
}

/** Error messages the workflow screens can show (workflow.errors.*). */
export const WORKFLOW_ERROR_KEYS = [
  "PERMISSION_DENIED",
  "ESCALATION_BLOCKED",
  "OWNER_ONLY",
  "SELF_GRANT_FORBIDDEN",
  "NOT_FOUND",
  "INVALID_STATE",
  "VALIDATION",
  "INVALID_CONDITION",
  "CATCH_ALL_REQUIRED",
  "RULE_IN_USE",
  "DUPLICATE",
  "REASON_REQUIRED",
  "UNAVAILABLE",
  "MFA_REQUIRED",
  "UNKNOWN",
] as const;
export type WorkflowErrorKey = (typeof WORKFLOW_ERROR_KEYS)[number];

/** Result of a workflow Server Action. Only a translatable key and a request id reach the browser. */
export type ActionResult = { ok: true } | { ok: false; messageKey: WorkflowErrorKey; requestId?: string };
/** `null` = the form has not been submitted yet (useActionState initial state). */
export type ActionState = ActionResult | null;
