import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import { MAX_ROWS, PREVIEW_ROWS, REJECTS_SHOWN } from "./logic";
import type { ImportBatchView, ImportRowView } from "./types";

/**
 * Import reads, through the user's session against api.v_import_* (security_invoker):
 * RLS returns rows only to holders of admin.import.run at scope "all".
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "imports.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "imports.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

const BATCH_COLUMNS =
  "id, kind, status, file_name, row_count, valid_count, error_count, committed_count, failure, failure_row_no, result, created_by, created_by_name_en, created_by_name_ar, created_at, validated_at, committed_at, discarded_at";
const ROW_COLUMNS = "id, batch_id, row_no, raw, normalized, errors, status, result";

export async function listBatches(limit = 50): Promise<Result<ImportBatchView[]>> {
  const db = await createClient();
  return run("v_import_batches", db.from("v_import_batches").select(BATCH_COLUMNS).order("created_at", { ascending: false }).limit(limit), []);
}

export async function getBatch(batchId: string): Promise<Result<ImportBatchView | null>> {
  const db = await createClient();
  return run("v_import_batches", db.from("v_import_batches").select(BATCH_COLUMNS).eq("id", batchId).maybeSingle(), null);
}

/** The first rows of the file, as uploaded. */
export async function previewRows(batchId: string): Promise<Result<ImportRowView[]>> {
  const db = await createClient();
  return run(
    "v_import_rows",
    db.from("v_import_rows").select(ROW_COLUMNS).eq("batch_id", batchId).order("row_no").limit(PREVIEW_ROWS),
    [],
  );
}

/** Rejected rows (status invalid), first REJECTS_SHOWN for the page or all for the file. */
export async function rejectedRows(batchId: string, all = false): Promise<Result<ImportRowView[]>> {
  const db = await createClient();
  const query = () => db.from("v_import_rows").select(ROW_COLUMNS).eq("batch_id", batchId).eq("status", "invalid").order("row_no");
  if (!all) return run("v_import_rows", query().limit(REJECTS_SHOWN), []);

  // PostgREST caps a response (1000 rows by default); page through up to the batch limit.
  const out: ImportRowView[] = [];
  const page = 1000;
  for (let from = 0; from < MAX_ROWS; from += page) {
    const chunk = await run<ImportRowView[]>("v_import_rows", query().range(from, from + page - 1), []);
    if (!chunk.ok) return chunk;
    out.push(...chunk.data);
    if (chunk.data.length < page) break;
  }
  return ok(out);
}
