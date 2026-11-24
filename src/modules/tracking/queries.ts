import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { HealthRow, TeamDayRow, TrackingDay, TrackingStatus } from "./types";

/**
 * Tracking reads, as the signed-in user. They are SECURITY DEFINER functions that
 * check scope themselves (a rep: only their own day; a manager: field.tracking.read
 * covering the employee), so a denied read comes back as PERMISSION_DENIED.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "tracking.read_failed", { fn: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "tracking.read_failed", { fn: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export async function getMyTrackingStatus(): Promise<Result<TrackingStatus | null>> {
  const db = await createClient();
  return run("my_tracking_status", db.rpc("my_tracking_status"), null);
}

/** api.tracking_team_day: one row per rep in the caller's scope for one Cairo day. */
export async function getTeamDay(day: string): Promise<Result<TeamDayRow[]>> {
  const db = await createClient();
  return run("tracking_team_day", db.rpc("tracking_team_day", { p_day: day }), []);
}

const HEALTH_COLUMNS =
  "employee_id, employee_no, full_name_en, full_name_ar, shift_id, shift_status, shift_open, shift_started_at, shift_ended_at, " +
  "shift_since, last_point_at, last_point_received_at, last_point_source, shift_last_received_at, shift_point_count, " +
  "device_reported_at, device_source, device_permission, device_app_version, device_web_build, device_battery_saver, " +
  "device_pending_points, checked_at, needs_attention";

/**
 * api.v_tracking_health (security_invoker): one row per trackable rep in the caller's D-14
 * scope, now. The view's roster and the tables' RLS decide the rows; no coordinates.
 */
export async function getTrackingHealth(): Promise<Result<HealthRow[]>> {
  const db = await createClient();
  return run("v_tracking_health", db.from("v_tracking_health").select(HEALTH_COLUMNS).order("employee_no").limit(500), []);
}

/** api.tracking_day: one rep, one Cairo day, with the timeline and the point list. */
export async function getTrackingDay(employeeId: string, day: string): Promise<Result<TrackingDay | null>> {
  const db = await createClient();
  return run("tracking_day", db.rpc("tracking_day", { p_employee_id: employeeId, p_day: day }), null);
}
