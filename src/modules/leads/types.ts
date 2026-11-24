import type { TranslatedCode } from "@/lib/errors";

type Num = number | string;

/** HONEST's own lead status (crm.leads.status). */
export const LEAD_STATUSES = ["new", "visited", "prospect", "customer", "not_interested"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
/** Statuses a person sets by hand (api.set_lead_status). */
export const MANUAL_LEAD_STATUSES = ["new", "visited", "not_interested"] as const;
export type ManualLeadStatus = (typeof MANUAL_LEAD_STATUSES)[number];

/** List filters on /leads. "open" = new or visited (the default). */
export const LEAD_FILTERS = ["open", "planned", "not_interested", "converted", "all"] as const;
export type LeadFilter = (typeof LEAD_FILTERS)[number];

/** api.v_leads */
export interface LeadRow {
  id: string;
  place_id: string;
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  status: LeadStatus;
  distance_m: Num | null;
  first_seen_at: string;
  last_seen_at: string | null;
  in_latest_run: boolean;
  notes: string | null;
  customer_id: string | null;
  customer_no: string | null;
  customer_name: string | null;
  customer_stage: string | null;
  planned_for: string | null;
  planned_today: boolean | null;
  status_changed_at: string;
  assigned_at: string;
  updated_at: string;
  version: number;
}

export const RUN_STATUSES = ["queued", "running", "done", "failed", "not_configured", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** api.v_lead_discovery_runs */
export interface LeadRunRow {
  id: string;
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  trigger: "base_location" | "owner" | "refresh";
  status: RunStatus;
  radius_km: Num;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  request_count: number;
  estimated_cost_usd: Num;
  places_found: number;
  leads_new: number;
  leads_seen: number;
  excluded_customers: number;
  other_rep: number;
  truncated: boolean;
  refusal: "daily_cap" | "monthly_budget" | null;
  error_code: string | null;
}

/** api.v_lead_stats */
export interface LeadStatsRow {
  employee_id: string;
  employee_name_en: string | null;
  employee_name_ar: string | null;
  total: number;
  new_count: number;
  visited_count: number;
  prospect_count: number;
  customer_count: number;
  not_interested_count: number;
  planned_today: number;
  visited_pct: Num | null;
  converted_pct: Num | null;
  last_run_status: RunStatus | null;
  last_run_finished_at: string | null;
}

/** api.v_employee_base_locations (only what the leads pages use). */
export interface BaseLocationRow {
  employee_id: string;
  full_name_en: string | null;
  full_name_ar: string | null;
  employment_status: string;
  base_address: string | null;
  base_lat: Num | null;
  base_lng: Num | null;
  base_location_source: "geocoded" | "manual" | null;
  lead_radius_km: Num;
}

/** api.lead_usage() (owner). */
export interface LeadUsage {
  today_requests: number;
  month_run_cost_usd: number;
  month_detail_requests: number;
  month_detail_cost_usd: number;
  daily_request_cap: number;
  monthly_budget_usd: number;
  run_request_limit: number;
  queued_runs: number;
}

/** What one discovery job did (cron and "Run now"); counts only, never places or coordinates. */
export type JobOutcome =
  | { status: "none" }
  | { status: "cancelled" | "not_configured"; runId: string }
  | { status: "refused"; runId: string; reason: "daily_cap" | "monthly_budget" }
  | { status: "done" | "failed"; runId: string; requests: number; leadsNew: number; truncated: boolean; errorCode: string | null };

/** Codes with their own message under leads.errors. */
export const LEADS_ERROR_CODES = [
  "DAILY_CAP",
  "PAST_DATE",
  "NO_BASE_LOCATION",
  "ALREADY_CUSTOMER",
  "DUPLICATE_CUSTOMER",
  "NOT_CONFIGURED",
  "CAP_REACHED",
  "BUDGET_REACHED",
] as const;
export type LeadsErrorCode = (typeof LEADS_ERROR_CODES)[number];

export type LeadsActionResult =
  | { ok: true; message?: "saved" | "planned" | "unplanned" | "moved" | "queued" | "ran"; count?: number }
  | { ok: false; messageKey: TranslatedCode; leadsCode?: LeadsErrorCode; requestId?: string };
export type LeadsActionState = LeadsActionResult | null;
