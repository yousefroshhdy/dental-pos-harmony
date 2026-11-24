import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { StepRow } from "./flow";
import type { LegacySessionView, QualityRow } from "./schemas";

/**
 * Reads for /admin/setup/legacy-import, as the signed-in user. The views are security_invoker:
 * RLS returns sessions and steps only to an owner holding admin.import.run company-wide.
 */
type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "legacy_import.read_failed", { view: name, code: appError.code });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "legacy_import.read_failed", { view: name, detail: cause instanceof Error ? cause.name : "unknown" });
    return fail(networkError(cause));
  }
}

const SESSION_COLUMNS =
  "id, status, file_name, file_sha256, summary, credits_mode, negative_stock, created_by, created_by_name_en, created_by_name_ar, created_at, completed_at, abandoned_at";
const STEP_COLUMNS =
  "session_id, step_no, kind, batch_id, batch_status, row_count, valid_count, error_count, committed_count, failure, failure_row_no, restaged_count, result";

/** The most recent session (open, completed or abandoned), or null. */
export async function getLatestSession(): Promise<Result<LegacySessionView | null>> {
  const db = await createClient();
  return run("v_legacy_import_sessions", db.from("v_legacy_import_sessions").select(SESSION_COLUMNS).order("created_at", { ascending: false }).limit(1).maybeSingle(), null);
}

export async function getSession(sessionId: string): Promise<Result<LegacySessionView | null>> {
  const db = await createClient();
  return run("v_legacy_import_sessions", db.from("v_legacy_import_sessions").select(SESSION_COLUMNS).eq("id", sessionId).maybeSingle(), null);
}

export async function listSteps(sessionId: string): Promise<Result<StepRow[]>> {
  const db = await createClient();
  return run("v_legacy_import_steps", db.from("v_legacy_import_steps").select(STEP_COLUMNS).eq("session_id", sessionId).order("step_no"), []);
}

/** A step's rejected rows: row number and error codes only (never the row's contents). */
export async function stepRejects(batchId: string, limit: number): Promise<Result<{ row_no: number; errors: string[] }[]>> {
  const db = await createClient();
  return run(
    "v_import_rows",
    db.from("v_import_rows").select("row_no, errors").eq("batch_id", batchId).eq("status", "invalid").order("row_no").limit(limit),
    [],
  );
}

export async function listQuality(sessionId: string, limit: number): Promise<Result<QualityRow[]>> {
  const db = await createClient();
  return run(
    "v_legacy_import_quality",
    db
      .from("v_legacy_import_quality")
      .select("session_id, issue, entity_type, entity_id, customer_id, product_id, code, label")
      .eq("session_id", sessionId)
      .order("issue")
      .order("code")
      .limit(limit),
    [],
  );
}
