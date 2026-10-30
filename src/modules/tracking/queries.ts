import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { TeamDayRow, TrackingDay, TrackingStatus } from "./types";

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

/** api.tracking_day: one rep, one Cairo day, with the timeline and the point list. */
export async function getTrackingDay(employeeId: string, day: string): Promise<Result<TrackingDay | null>> {
  const db = await createClient();
  return run("tracking_day", db.rpc("tracking_day", { p_employee_id: employeeId, p_day: day }), null);
}
