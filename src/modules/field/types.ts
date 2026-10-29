import type { TranslatedCode } from "@/lib/errors";

/**
 * Row shapes of the field/work read views and command results
 * (supabase/migrations/20261029000200_crm_field_commands.sql, 20261029001050_audit_fix_functions.sql).
 */

export const VISIT_STATUSES = ["planned", "in_progress", "completed", "cancelled", "missed"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "out_of_range",
  "low_accuracy",
  "no_customer_location",
  "no_device_location",
  "exception_requested",
  "exception_approved",
  "exception_rejected",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Verdicts for which api.request_visit_exception accepts a request. */
export const EXCEPTION_ELIGIBLE = ["out_of_range", "no_customer_location", "no_device_location", "low_accuracy"] as const;

export const VISIT_OUTCOMES = [
  "order_taken",
  "interested",
  "follow_up",
  "not_interested",
  "doctor_unavailable",
  "collection",
  "demo",
  "complaint",
  "other",
] as const;
export type VisitOutcome = (typeof VISIT_OUTCOMES)[number];

export const ANOMALY_FLAGS = ["clock_skew", "late_sync", "duplicate_fix", "impossible_travel"] as const;

export const TASK_KINDS = ["follow_up", "collection", "visit_prep", "approval", "quality", "general"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** api.v_my_today */
export interface TodayItem {
  item_type: "task" | "visit";
  item_id: string;
  title: string;
  kind: TaskKind | null;
  priority: TaskPriority | null;
  /** Task status ('open') or visit status ('planned' | 'in_progress'). */
  status: string;
  customer_id: string | null;
  customer_name: string | null;
  /** Task due time, or the visit's check-in time. */
  due_at: string | null;
  planned_for: string | null;
  is_overdue: boolean;
}

/** api.v_visits */
export interface VisitRow {
  id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  planned_for: string | null;
  status: VisitStatus;
  check_in_at: string | null;
  check_in_received_at: string | null;
  /** numeric: PostgREST may send a number or a string. */
  check_in_distance_m: number | string | null;
  check_in_accuracy_m: number | string | null;
  check_out_at: string | null;
  verification_status: VerificationStatus;
  anomaly_flags: string[];
  outcome: VisitOutcome | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** api.v_tasks */
export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  kind: TaskKind;
  priority: TaskPriority;
  status: TaskStatus;
  due_at: string;
  completed_at: string | null;
  outcome: string | null;
  source: string;
  ref_table: string | null;
  ref_id: string | null;
  customer_id: string | null;
  customer_no: string | null;
  customer_name: string | null;
  assignee_employee_id: string;
  assignee_name_en: string | null;
  assignee_name_ar: string | null;
  is_overdue: boolean;
  created_at: string;
}

/** The api.v_customers columns the ad-hoc check-in picker needs. */
export interface CustomerPick {
  id: string;
  customer_no: string | null;
  display_name: string;
  city: string | null;
  location_verified: boolean | null;
}

/** api.visit_check_in result. */
export interface CheckInResult {
  visit_id: string;
  verification_status: VerificationStatus;
  distance_m: number | string | null;
  anomaly_flags?: string[];
  replayed: boolean;
}

/** api.visit_check_out result. */
export interface CheckOutResult {
  visit_id: string;
  status: VisitStatus;
  outcome: VisitOutcome;
  follow_up_task_id: string | null;
  replayed: boolean;
}

/** api.complete_task result. */
export interface CompleteTaskResult {
  task_id: string;
  status: "done";
  replayed: boolean;
}

/** api.request_visit_exception result. */
export interface ExceptionResult {
  approval_request_id: string;
  verification_status: "exception_requested";
  replayed: boolean;
}

/**
 * Result of a device command (check-in, check-out, exception). Serializable so
 * the offline queue can store it. `retryable` = the same payload may be sent
 * again safely (the commands are idempotent on the visit id).
 */
export type DeviceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; messageKey: TranslatedCode; retryable: boolean; requestId?: string };

/** Result of a form Server Action (tasks). */
export type ActionResult = { ok: true } | { ok: false; messageKey: TranslatedCode; code?: string; requestId?: string };
export type ActionState = ActionResult | null;
