import type { TranslatedCode } from "@/lib/errors";
import type { LifecycleStage } from "@/modules/crm/types";

type Num = number | string;

/** api.v_customer_map */
export interface CustomerMapRow {
  id: string;
  customer_no: string;
  display_name: string;
  kind: string;
  lifecycle_stage: LifecycleStage;
  city: string | null;
  latitude: Num | null;
  longitude: Num | null;
  location_verified: boolean;
  territory_id: string | null;
  territory_name_en: string | null;
  territory_name_ar: string | null;
  primary_rep_employee_id: string | null;
  primary_rep_name_en: string | null;
  primary_rep_name_ar: string | null;
  /** NULL = masked (no crm.customer_balance.read for this customer). */
  is_overdue: boolean | null;
  max_days_overdue: number | null;
  last_visit_on: string | null;
}

/** api.v_team_last_location: one row per rep on an open shift (D-14). */
export interface TeamLocationRow {
  employee_id: string;
  full_name_en: string | null;
  full_name_ar: string | null;
  shift_id: string;
  shift_started_at: string;
  point_source: "ping" | "shift_start";
  latitude: Num;
  longitude: Num;
  accuracy_m: Num | null;
  captured_at: string;
  anomaly_flags: string[];
}

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** api.v_customer_location_proposals */
export interface LocationProposalRow {
  id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
  territory_name_en: string | null;
  territory_name_ar: string | null;
  customer_has_location: boolean | null;
  visit_id: string;
  proposed_by: string;
  proposed_by_name_en: string | null;
  proposed_by_name_ar: string | null;
  latitude: Num;
  longitude: Num;
  accuracy_m: Num | null;
  captured_at: string;
  anomaly_flags: string[];
  status: ProposalStatus;
  decided_by_name_en: string | null;
  decided_by_name_ar: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/** api.tracking_day_visit_fixes */
export interface VisitFix {
  visit_id: string;
  customer_id: string;
  event_type: "check_in" | "check_out";
  latitude: Num;
  longitude: Num;
  accuracy_m: Num | null;
  captured_at: string;
}

/** "Not visited in the last N days" (never visited included), or never visited at all. */
export const LAST_VISIT_FILTERS = ["30", "60", "90", "never"] as const;
export type LastVisitFilter = (typeof LAST_VISIT_FILTERS)[number];

/** Error codes the maps module translates itself (maps.errors.*). */
export const MAPS_ERROR_CODES = ["ALREADY_PINNED", "LOCATION_INACCURATE", "OUTSIDE_EGYPT"] as const;
export type MapsErrorCode = (typeof MAPS_ERROR_CODES)[number];

export type MapsActionResult =
  | { ok: true }
  | { ok: false; messageKey: TranslatedCode; mapsCode?: MapsErrorCode; requestId?: string };
export type MapsActionState = MapsActionResult | null;
