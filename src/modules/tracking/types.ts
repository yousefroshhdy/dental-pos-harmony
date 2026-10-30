import type { TranslatedCode } from "@/lib/errors";

/**
 * Work-hours tracking (docs/DECISIONS.md D-14). Shapes mirror the api.* answers in
 * supabase/migrations/20261031000300_tracking.sql. Timestamps are ISO strings.
 */

export const SHIFT_STATUSES = ["open", "closed", "auto_closed"] as const;
export type ShiftStatus = (typeof SHIFT_STATUSES)[number];

/** Flags on one location point (api.record_location_pings). */
export const PING_FLAGS = ["low_accuracy", "impossible_travel", "duplicate_fix", "clock_skew"] as const;
export type PingFlag = (typeof PING_FLAGS)[number];

/**
 * Flags on a rep's day (field.tracking_compute_day). Signals for review, never penalties.
 * The last five are the shifts' own anomaly flags, carried into the day (audit 3, M4).
 */
export const DAY_FLAGS = [
  "idle_stop",
  "gap",
  "auto_closed",
  "anomaly",
  "overdue_shift",
  "late_sync",
  "clock_skew",
  "no_device_location",
  "no_device_location_end",
  "overlap_clamped",
] as const;
export type DayFlag = (typeof DAY_FLAGS)[number];

/** Why api.record_location_pings did not store a point (the device drops it; never retried). */
export const REJECT_REASONS = ["invalid", "conflict", "outside_shift", "too_late", "too_frequent", "shift_cap"] as const;

export interface TrackingNotice {
  version: string;
  body_ar: string;
  body_en: string;
  published_at: string;
}

export interface OpenShift {
  id: string;
  /** The device ref that started it (api.end_shift's p_shift_ref). */
  client_ref: string;
  status: ShiftStatus;
  started_at: string;
  window_start: string;
  max_end_at: string;
  /** Open past the maximum length: the server closes it and refuses new points. */
  overdue: boolean;
  last_ping_at: string | null;
  last_ping_received_at: string | null;
  ping_count: number;
}

export interface TrackingSettings {
  sample_interval_s: number;
  max_shift_hours: number;
  retention_days: number;
  max_accuracy_m: number;
  max_batch: number;
  work_days: string[] | null;
  work_hours: { start: string; end: string } | null;
}

/** api.my_tracking_status() */
export interface TrackingStatus {
  employee_id: string | null;
  can_start: boolean;
  server_now: string;
  business_date: string;
  notice: TrackingNotice | null;
  acknowledged_at: string | null;
  open_shift: OpenShift | null;
  today_shift_seconds: number;
  settings: TrackingSettings;
}

/** One row of api.tracking_team_day(day). */
export interface TeamDayRow {
  employee_id: string;
  employee_no: string;
  full_name_en: string;
  full_name_ar: string | null;
  business_date: string;
  on_shift: boolean;
  shift_count: number;
  shift_seconds: number;
  first_start_at: string | null;
  last_end_at: string | null;
  visit_count: number;
  visit_seconds: number;
  idle_stop_count: number;
  idle_stop_seconds: number;
  gap_count: number;
  gap_seconds: number;
  distance_m: number | string;
  ping_count: number;
  last_ping_at: string | null;
  flags: string[];
  from_summary: boolean;
}

export interface DayShift {
  id: string;
  status: ShiftStatus;
  start_at: string;
  end_at: string;
  open: boolean;
  seconds: number;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  anomaly_flags: string[];
}

export interface DayVisit {
  id: string;
  customer_id: string;
  /** Only when the viewer may read the visit (field.visit.read scope, or their own). */
  customer_name: string | null;
  status: string;
  verification_status: string;
  start_at: string;
  end_at: string | null;
  seconds: number;
  open: boolean;
}

export interface DayStop {
  shift_id: string;
  start_at: string;
  end_at: string;
  seconds: number;
  lat: number;
  lng: number;
  points: number;
  in_visit: boolean;
  near_customer: boolean;
  /** Away from every visit and customer location: for the manager to review. */
  flagged: boolean;
}

export interface DayGap {
  shift_id: string;
  start_at: string;
  end_at: string;
  seconds: number;
  ongoing: boolean;
}

export interface DayPoint {
  id: string;
  shift_id: string;
  captured_at: string;
  received_at: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  source: "pwa" | "native";
  anomaly_flags: string[];
  /** Counted for distance and stops (not low accuracy, impossible travel or a duplicate). */
  usable: boolean;
}

/** api.tracking_day(employee, day) */
export interface TrackingDay {
  employee_id: string;
  employee: { id: string; employee_no: string; full_name_en: string; full_name_ar: string | null };
  day: string;
  on_shift: boolean;
  shift_count: number;
  shift_seconds: number;
  first_start_at: string | null;
  last_end_at: string | null;
  visit_count: number;
  visit_seconds: number;
  idle_stop_count: number;
  idle_stop_seconds: number;
  gap_count: number;
  gap_seconds: number;
  distance_m: number | string;
  ping_count: number;
  last_ping_at: string | null;
  flags: string[];
  shifts: DayShift[];
  visits: DayVisit[];
  stops: DayStop[];
  gaps: DayGap[];
  /** At most `points_limit` points, in time order; `ping_count` counts them all. */
  points: DayPoint[];
  /** More points were recorded than the list carries (tracking.max_day_points). */
  points_truncated?: boolean;
  points_limit?: number;
  /** The raw points of this day are past retention (deleted). */
  raw_purged: boolean;
  /**
   * The retention purge summarized this day: the figures are the stored summary, and no
   * stops, gaps or points are listed (audit 3, M7).
   */
  summary_only?: boolean;
  retention_days?: number;
  stored_summary: Record<string, unknown> | null;
}

/** One location point as the device sends it. */
export interface PingInput {
  [key: string]: string | number | null;
  id: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  captured_at: string;
  source: "pwa";
}

export interface PingsResult {
  accepted: number;
  duplicates: number;
  rejected: { id: string; reason: string }[];
  replayed: boolean;
}

export interface StartShiftResult {
  shift_id: string;
  status: ShiftStatus;
  window_start: string;
  max_end_at: string;
  replayed: boolean;
}

export interface EndShiftResult {
  shift_id: string;
  status: ShiftStatus;
  window_start: string;
  window_end: string;
  shift_seconds: number;
  replayed: boolean;
}

export interface AckResult {
  version: string;
  acknowledged_at: string;
  replayed: boolean;
}

/** A device command's answer (same contract as the field module's device actions). */
export type DeviceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; messageKey: TranslatedCode; retryable: boolean; requestId?: string };
