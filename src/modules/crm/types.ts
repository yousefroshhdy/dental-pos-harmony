import type { TranslatedCode } from "@/lib/errors";

/**
 * Row shapes of the api.v_* views used by the CRM screens
 * (supabase/migrations/20261029000200_crm_field_commands.sql, 20261030000100_crm_ui_reads.sql).
 * numeric columns may arrive from PostgREST as a number or a string.
 */

export const LIFECYCLE_STAGES = ["lead", "prospect", "active", "dormant", "lost", "blocked"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const CUSTOMER_KINDS = ["clinic", "doctor", "hospital", "university", "lab", "distributor"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

export const CUSTOMER_SOURCES = ["field", "referral", "website", "shopify", "event", "academy", "import", "other"] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

/** Activity types a user may log by hand (api.log_activity). */
export const MANUAL_ACTIVITY_TYPES = ["call", "whatsapp", "email", "meeting", "note"] as const;
export type ManualActivityType = (typeof MANUAL_ACTIVITY_TYPES)[number];

/** Every crm.activities type (timeline display). */
export const ACTIVITY_TYPES = [
  "call",
  "whatsapp",
  "email",
  "visit",
  "meeting",
  "note",
  "order",
  "invoice",
  "payment",
  "stage_change",
  "assignment",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const OPPORTUNITY_STAGES = ["new", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export interface CustomerRow {
  id: string;
  customer_no: string;
  kind: CustomerKind;
  doctor_name: string | null;
  clinic_name: string | null;
  display_name: string;
  specialty_code: string | null;
  lifecycle_stage: LifecycleStage;
  source: CustomerSource | null;
  phone_primary: string | null;
  phone_secondary: string | null;
  email: string | null;
  address_line: string | null;
  city: string | null;
  governorate_code: string | null;
  territory_id: string | null;
  territory_code: string | null;
  territory_name_en: string | null;
  territory_name_ar: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  location_verified: boolean;
  tags: string[];
  notes: string | null;
  version: number;
  primary_rep_employee_id: string | null;
  primary_rep_name_en: string | null;
  primary_rep_name_ar: string | null;
  /** NULL when masked (no crm.customer_balance.read in scope). */
  balance: number | string | null;
  balance_updated_at: string | null;
  credit_limit: number | string | null;
  payment_terms_days: number | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** The columns the list screen needs (keeps the payload small on mobile). */
export type CustomerListRow = Pick<
  CustomerRow,
  | "id"
  | "customer_no"
  | "display_name"
  | "doctor_name"
  | "lifecycle_stage"
  | "specialty_code"
  | "phone_primary"
  | "city"
  | "governorate_code"
  | "territory_name_en"
  | "territory_name_ar"
  | "primary_rep_name_en"
  | "primary_rep_name_ar"
  | "location_verified"
  | "latitude"
>;

export interface TimelineRow {
  id: string;
  customer_id: string;
  type: ActivityType;
  occurred_at: string;
  summary: string | null;
  employee_id: string | null;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  ref_table: string | null;
  ref_id: string | null;
  created_at: string;
}

export interface OpportunityRow {
  id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  title: string;
  brand_id: string | null;
  brand_code: string | null;
  brand_name: string | null;
  stage: OpportunityStage;
  expected_value: number | string | null;
  probability_pct: number | null;
  expected_close_date: string | null;
  lost_reason: string | null;
  won_order_id: string | null;
  owner_employee_id: string;
  owner_name_en: string | null;
  owner_name_ar: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GovernorateRow {
  code: string;
  name_en: string;
  name_ar: string;
}

export interface SpecialtyRow {
  code: string;
  name_en: string;
  name_ar: string;
}

export interface TerritoryRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
}

export interface EmployeeOption {
  id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  job_title: string;
}

/** api.find_duplicate_customers result. */
export interface DuplicateCheck {
  phone_duplicate_customer_no: string | null;
  similar_count: number;
  similar_customer_nos: string[];
}

/** api.create_customer result. */
export interface CreateCustomerResult {
  customer_id: string;
  customer_no: string;
  territory_id: string | null;
  owner_employee_id?: string | null;
  warnings: { code: string; count?: number; customer_nos?: string[] }[];
  replayed: boolean;
}

/** Codes with a CRM-specific message under crm.errors.* (others fall back to errors.*). */
export const CRM_ERROR_CODES = [
  "DUPLICATE_CUSTOMER",
  "NO_EMPLOYEE_PROFILE",
  "WORKFLOW_MISSING",
  "CUSTOMER_BLOCKED",
  "LOCATION_UNAVAILABLE",
  "LOCATION_INACCURATE",
] as const;
export type CrmErrorCode = (typeof CRM_ERROR_CODES)[number];

/** What a failed CRM action sends to the browser: translatable keys, never raw SQL text. */
export interface ActionFailure {
  ok: false;
  messageKey: TranslatedCode;
  /** Set when crm.errors.<code> has a more specific message. */
  crmCode?: CrmErrorCode;
  /** Safe interpolation values (e.g. the existing customer number of a duplicate). */
  params?: Record<string, string>;
  requestId?: string;
  invalidFields?: string[];
}

export type ActionResult = { ok: true } | ActionFailure;
/** `null` = not submitted yet (useActionState initial state). */
export type ActionState = ActionResult | null;

/** A failed form submit keeps what the user typed so the form can be refilled. */
export type FormFailure = ActionFailure & { values?: Record<string, string> };

/** Create-customer form: may stop to ask the user to confirm possible duplicates. */
export type CreateCustomerState =
  | null
  | FormFailure
  | { ok: "confirm"; similar: string[]; similarCount: number; values: Record<string, string> };

/** A small form whose failure refills what the user typed (React resets forms after an action). */
export type FormResultState = null | { ok: true } | FormFailure;

/** Edit-customer form. */
export type CustomerFormState = null | FormFailure;
