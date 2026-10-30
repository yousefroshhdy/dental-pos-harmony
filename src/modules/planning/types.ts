import type { TranslatedCode } from "@/lib/errors";

/**
 * Row shapes of the planning read views and command results
 * (supabase/migrations/20261103000900_planning.sql).
 */

export const VISIT_CLASSES = ["A", "B", "C"] as const;
export type VisitClass = (typeof VISIT_CLASSES)[number];

/** field.visits statuses as they appear in api.v_visit_plan (cancelled plans are left out). */
export const PLAN_STATUSES = ["planned", "in_progress", "completed", "missed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Day names as stored in planning.work_days (index = JS getUTCDay / Postgres dow). */
export const WEEK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/** Why the generator proposes a visit. */
export const PROPOSAL_REASONS = ["never_visited", "overdue", "due"] as const;
export type ProposalReason = (typeof PROPOSAL_REASONS)[number];

/** api.v_visit_plan */
export interface PlanRow {
  id: string;
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  visit_class: VisitClass;
  planned_for: string;
  week_start: string;
  day_of_week: number;
  status: PlanStatus;
  verification_status: string;
  check_in_at: string | null;
  check_out_at: string | null;
  outcome: string | null;
  can_unplan: boolean;
  is_missed: boolean;
  created_at: string;
}

/** api.v_planning_employees */
export interface PlanningEmployee {
  id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  job_title: string;
  is_me: boolean;
}

/** api.v_planning_customers */
export interface PlanningCustomer {
  employee_id: string;
  customer_id: string;
  assignment_role: string;
  customer_no: string;
  customer_name: string;
  lifecycle_stage: string;
  visit_class: VisitClass;
}

/** api.v_coverage / api.coverage(from, to) */
export interface CoverageRow {
  customer_id: string;
  customer_no: string;
  customer_name: string;
  territory_id: string | null;
  lifecycle_stage: string;
  employee_id: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  visit_class: VisitClass;
  class_is_default: boolean;
  interval_days: number;
  period_start: string;
  period_end: string;
  target_visits: number;
  actual_visits: number;
  target_met: boolean;
  last_visit_on: string | null;
  days_since_last_visit: number | null;
  next_due_on: string;
  is_overdue: boolean;
  overdue_days: number | null;
  next_planned_on: string | null;
}

/** api.planning_settings() */
export interface PlanningSettings {
  intervals: Record<VisitClass, number>;
  default_class: VisitClass;
  daily_cap: number;
  work_days: WeekDay[];
  today: string;
}

/** One visit proposed by api.generate_plan. */
export interface Proposal {
  customer_id: string;
  customer_no: string;
  customer_name: string;
  visit_class: VisitClass;
  date: string;
  due_on: string;
  last_visit_on: string | null;
  reason: ProposalReason;
}

/** api.generate_plan(employee, month) */
export interface GeneratedPlan {
  employee_id: string;
  month: string;
  from: string;
  to: string;
  daily_cap: number;
  work_days: WeekDay[];
  customers: number;
  days: { date: string; existing: number; proposed: number }[];
  proposals: Proposal[];
  unscheduled: {
    customer_id: string;
    customer_no: string;
    customer_name: string;
    visit_class: VisitClass;
    due_on: string;
    reason: "no_capacity";
  }[];
}

/** api.plan_visits result */
export interface PlanResult {
  client_ref: string;
  employee_id: string;
  created: number;
  from: string | null;
  to: string | null;
  visits: { visit_id: string; customer_id: string; date: string }[];
  replayed: boolean;
}

export type ActionResult =
  | { ok: true; created?: number; from?: string | null }
  | { ok: false; messageKey: TranslatedCode; code?: string; requestId?: string };
export type ActionState = ActionResult | null;
