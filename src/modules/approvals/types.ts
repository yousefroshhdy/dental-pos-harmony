/**
 * Row shapes of the views used by the approvals and notifications screens:
 * api.v_approval_requests / api.v_approval_steps (supabase/migrations/20261030000500_approvals_ui.sql)
 * and api.v_notifications (…_platform_admin.sql).
 */

export type RequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";

/** Why the caller can or cannot decide (authz.approval_verdict). */
export type Verdict = "ok" | "own_request" | "about_you" | "limit" | "already_decided" | "not_approver" | "closed";

export type Decision = "approved" | "rejected";

export interface ApprovalRequestRow {
  request_id: string;
  workflow_code: string;
  workflow_name: string;
  entity_type: string;
  entity_id: string;
  /** Frozen snapshot of what is being approved; shape depends on the workflow. */
  payload: Record<string, unknown> | null;
  status: RequestStatus;
  current_stage: number;
  /** NULL when the caller may not read the workflow configuration (no wf.approval.read). */
  stage_count: number | null;
  stage_approver_type: string | null;
  stage_permission: string | null;
  stage_required_approvals: number | null;
  stage_approvals: number;
  stage_started_at: string;
  created_at: string;
  decided_at: string | null;
  requested_by: string;
  requester_name_en: string | null;
  requester_name_ar: string | null;
  subject_employee_id: string | null;
  subject_name_en: string | null;
  subject_name_ar: string | null;
  is_mine: boolean;
  can_decide: boolean;
  my_verdict: Verdict | null;
  decided_by_me: boolean;
  my_decision: Decision | null;
  my_decided_at: string | null;
  customer_no: string | null;
  customer_name: string | null;
  from_employee_name_en: string | null;
  from_employee_name_ar: string | null;
  to_employee_name_en: string | null;
  to_employee_name_ar: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  variant_sku: string | null;
  variant_name: string | null;
}

export interface ApprovalStepRow {
  id: string;
  request_id: string;
  stage_no: number;
  decision: Decision;
  comment: string | null;
  decided_at: string;
  approver_id: string;
  approver_name_en: string | null;
  approver_name_ar: string | null;
  on_behalf_of: string | null;
  on_behalf_of_name_en: string | null;
  on_behalf_of_name_ar: string | null;
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

/** Keys under `approvals.errors.*` (both locales). */
export const APPROVAL_ERROR_KEYS = [
  "SELF_APPROVAL",
  "LIMIT_EXCEEDED",
  "ALREADY_DECIDED",
  "PERMISSION_DENIED",
  "INVALID_STATE",
  "NOT_FOUND",
  "WORKFLOW_MISSING",
  "INSUFFICIENT_STOCK",
  "COMMENT_REQUIRED",
  "VALIDATION",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type ApprovalErrorKey = (typeof APPROVAL_ERROR_KEYS)[number];

/** Result of an approvals Server Action. Only a translatable key and a request id reach the browser. */
export type ActionResult =
  | { ok: true; status?: RequestStatus; currentStage?: number }
  | { ok: false; messageKey: ApprovalErrorKey; requestId?: string };
/** `null` = the form has not been submitted yet (useActionState initial state). */
export type ActionState = ActionResult | null;

export type InboxTab = "decide" | "mine" | "decided";
