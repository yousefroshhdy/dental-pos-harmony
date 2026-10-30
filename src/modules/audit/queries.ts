import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { getRequestId } from "@/lib/request-id";
import { createClient } from "@/lib/supabase/server";
import type { ActorOption, AuditEntry, AuditFilters, AuditTable } from "./types";

/**
 * Audit reader calls. They run as the signed-in user; api.audit_* allow only
 * holders of audit.row_image.read (the owner by default), mask sensitive values
 * and record every read as a security event. Reads are never retried
 * automatically, so a page view writes one access-log row.
 */

export const PAGE_SIZE = 50;
export const HISTORY_PAGE_SIZE = 100;

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: () => Query, empty: T): Promise<Result<T>> {
  const requestId = await getRequestId();
  try {
    const { data, error } = await query();
    if (error) {
      const appError = parseDbError(error, requestId);
      log("warn", "audit.read_failed", { source: name, requestId, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "audit.read_failed", { source: name, requestId, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause, requestId));
  }
}

export async function searchAudit(f: AuditFilters): Promise<Result<AuditEntry[]>> {
  const db = await createClient();
  return run(
    "audit_search",
    () =>
      db.rpc("audit_search", {
        p_table_schema: f.tableSchema ?? null,
        p_table_name: f.tableName ?? null,
        p_record_id: f.recordId ?? null,
        p_actor_user_id: f.actorUserId ?? null,
        p_from: f.from ?? null,
        p_to: f.to ?? null,
        p_action: f.action ?? null,
        p_before_id: f.beforeId ?? null,
        p_limit: PAGE_SIZE,
        p_reveal: f.reveal,
      }),
    [],
  );
}

export async function recordHistory(
  schema: string,
  table: string,
  recordId: string,
  opts: { beforeId?: number; reveal: boolean },
): Promise<Result<AuditEntry[]>> {
  const db = await createClient();
  return run(
    "audit_record_history",
    () =>
      db.rpc("audit_record_history", {
        p_table_schema: schema,
        p_table_name: table,
        p_record_id: recordId,
        p_before_id: opts.beforeId ?? null,
        p_limit: HISTORY_PAGE_SIZE,
        p_reveal: opts.reveal,
      }),
    [],
  );
}

export async function listAuditedTables(): Promise<Result<AuditTable[]>> {
  const db = await createClient();
  return run("audit_tables", () => db.rpc("audit_tables"), []);
}

/** Actor filter options. Needs admin.user.read (the owner holds it); otherwise the filter takes an id. */
export async function listActors(): Promise<Result<ActorOption[]>> {
  const db = await createClient();
  return run(
    "v_users",
    () =>
      db
        .from("v_users")
        .select("user_id, employee_no, full_name_en, full_name_ar")
        .order("employee_no", { ascending: true, nullsFirst: false }),
    [],
  );
}
