import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import { parseDbError, type AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { columnsFor, csvNote, headersFor, rowValues, type Row } from "./columns";
import { BOM, cairoToday, csvRow } from "./csv";
import { canExport, isExportKind, type ExportKind } from "./kinds";
import { exportLocale, parseExportFilters } from "./schemas";
import { ExportReadError, SOURCES, type Db } from "./sources";

/**
 * GET /api/export/[kind] — streams a CSV of what the signed-in user can see.
 *
 * - Reads with the user's own session (RLS applies); never the service role.
 * - 401 without a session, 403 without the list page's permission, 400 for
 *   invalid filters, 404 for an unknown export.
 * - Before anything is read, `api.log_export` authorizes the export in the
 *   database (kind whitelist, permissions, MFA step-up, rate limit) and logs it
 *   to audit.security_events. If that call fails, the export fails (fail
 *   closed): 403 (permission or `mfa_required`), 429 (`rate_limited`), else 500.
 * - When the stream ends, `api.log_export_result` records the final row count
 *   (best effort: the file has been sent; a failure goes to the app log).
 * - At most `rowCap` rows; a note row says when the file was cut short.
 * - The first page is read before the response starts, so a database error
 *   is a proper status code; a failure after that ends the file with a note row.
 *
 * The handler takes its dependencies as arguments so it can be unit-tested
 * with a mocked Supabase client.
 */
export interface ExportDeps {
  getContext: () => Promise<UserContext>;
  /** The user-session client (src/lib/supabase/server.ts). */
  createClient: () => Promise<Db>;
  rowCap: () => number;
  now?: () => Date;
  requestId?: () => string;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function jsonError(status: number, error: string, requestId: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, requestId, ...extra }, { status, headers: { ...NO_STORE, "X-Request-Id": requestId } });
}

function statusFor(error: AppError): number {
  if (error.code === "PERMISSION_DENIED" || error.code === "MFA_REQUIRED") return 403;
  if (error.code === "RATE_LIMITED") return 429;
  if (error.code === "VALIDATION") return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "UNAVAILABLE") return 503;
  return 500;
}

function readError(cause: unknown): AppError {
  if (cause instanceof ExportReadError) return parseDbError(cause.dbError);
  return { code: "UNAVAILABLE", messageKey: "UNAVAILABLE", detail: cause instanceof Error ? cause.message : String(cause), retryable: false };
}

/** Filters for the logs: values are ids, codes and dates; free-text search is redacted; unset values dropped. */
export function loggableFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, k === "q" ? "[redacted]" : v]),
  );
}

/** The JSON error name the route returns when the database refuses the export. */
export function refusalName(error: AppError): string {
  if (error.code === "PERMISSION_DENIED") return "forbidden";
  if (error.code === "MFA_REQUIRED") return "mfa_required";
  if (error.code === "RATE_LIMITED") return "rate_limited";
  return "export_failed";
}

/** Seconds a rate-limited user should wait (the database window is 10 minutes). */
export const RATE_LIMIT_RETRY_AFTER_S = 600;

type LogResult = { ok: true; exportId: number | string | null } | { ok: false; error: AppError };

/** Server-side gate and security log (api.log_export). Any failure refuses the export. */
export async function openExportLog(db: Db, kind: ExportKind, filters: Record<string, unknown>, requestId: string): Promise<LogResult> {
  try {
    const { data, error } = await db.rpc("log_export", {
      p_kind: kind,
      p_filters: loggableFilters(filters),
      p_row_count: null,
      p_request_id: requestId,
    });
    if (error) return { ok: false, error: parseDbError(error, requestId) };
    return { ok: true, exportId: typeof data === "number" || typeof data === "string" ? data : null };
  } catch (cause) {
    return { ok: false, error: readError(cause) };
  }
}

/** Final row count (api.log_export_result). Best effort: the file is already sent. */
async function closeExportLog(
  db: Db,
  exportId: number | string | null,
  result: { rows: number; truncated: boolean; failed: boolean },
  meta: { requestId: string; userId: string; kind: ExportKind },
): Promise<void> {
  if (exportId === null) return;
  try {
    const { error } = await db.rpc("log_export_result", {
      p_export_id: exportId,
      p_row_count: result.rows,
      p_truncated: result.truncated,
      p_failed: result.failed,
    });
    if (error) {
      const e = parseDbError(error);
      log("error", "reports.export_result_failed", { request_id: meta.requestId, user_id: meta.userId, kind: meta.kind, code: e.code, detail: e.detail });
    }
  } catch (cause) {
    log("error", "reports.export_result_failed", { request_id: meta.requestId, user_id: meta.userId, kind: meta.kind, code: "UNAVAILABLE", detail: cause instanceof Error ? cause.message : String(cause) });
  }
}

export async function handleExport(request: Request, kindParam: string, deps: ExportDeps): Promise<Response> {
  const requestId = deps.requestId?.() ?? request.headers.get("x-vercel-id") ?? crypto.randomUUID();
  const now = deps.now?.() ?? new Date();

  if (!isExportKind(kindParam)) return jsonError(404, "unknown_export", requestId);
  const kind: ExportKind = kindParam;

  let ctx: UserContext;
  try {
    ctx = await deps.getContext();
  } catch {
    ctx = ANONYMOUS_CONTEXT;
  }
  if (!ctx.user_id) return jsonError(401, "unauthenticated", requestId);
  if (!ctx.active || !canExport(ctx, kind)) {
    log("warn", "reports.export_denied", { request_id: requestId, user_id: ctx.user_id, kind });
    return jsonError(403, "forbidden", requestId);
  }

  const params = new URL(request.url).searchParams;
  const parsed = parseExportFilters(kind, params);
  if (!parsed.ok) return jsonError(400, "invalid_filters", requestId, { fields: parsed.fields });
  const filters = parsed.filters;
  const locale = exportLocale(params, ctx.locale === "en" ? "en" : "ar");

  const cap = Math.max(1, deps.rowCap());
  const db = await deps.createClient();

  // Server-side gate and audit trail before any data is read (fail closed).
  const opened = await openExportLog(db, kind, filters, requestId);
  if (!opened.ok) {
    const error = opened.error;
    log("warn", "reports.export_refused", { request_id: requestId, user_id: ctx.user_id, kind, code: error.code, detail: error.detail });
    const extra: Record<string, string> = error.code === "RATE_LIMITED" ? { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_S) } : {};
    return Response.json(
      { error: refusalName(error), requestId },
      { status: statusFor(error), headers: { ...NO_STORE, "X-Request-Id": requestId, ...extra } },
    );
  }
  const exportId = opened.exportId;

  const rows = SOURCES[kind]({ db, ctx, filters, limit: cap + 1, now });

  // First batch before the response starts: errors become status codes.
  let first: IteratorResult<Row[]>;
  try {
    first = await rows.next();
  } catch (cause) {
    const error = readError(cause);
    log("warn", "reports.export_failed", { request_id: requestId, user_id: ctx.user_id, kind, code: error.code, detail: error.detail });
    await closeExportLog(db, exportId, { rows: 0, truncated: false, failed: true }, { requestId, userId: ctx.user_id, kind });
    return jsonError(statusFor(error), error.code === "PERMISSION_DENIED" ? "forbidden" : "export_failed", requestId);
  }

  const columns = columnsFor(kind, ctx);
  const started = Date.now();

  async function* chunks(): AsyncGenerator<string> {
    yield BOM + csvRow(headersFor(columns, locale));
    let count = 0;
    let truncated = false;
    let failed = false;
    let finished = false;
    let batch = first;
    try {
      try {
        while (!batch.done) {
          const room = cap - count;
          const take = batch.value.length > room ? batch.value.slice(0, room) : batch.value;
          // Counted before the yield: a cancel at the yield still counts the rows handed to the stream.
          count += take.length;
          if (take.length > 0) yield take.map((r) => csvRow(rowValues(columns, r, locale))).join("");
          if (batch.value.length > room) {
            truncated = true;
            break;
          }
          batch = await rows.next();
        }
      } catch (cause) {
        failed = true;
        const error = readError(cause);
        log("error", "reports.export_interrupted", { request_id: requestId, user_id: ctx.user_id, kind, rows: count, code: error.code, detail: error.detail });
      }
      finished = true;
    } finally {
      await rows.return(undefined);
      // A download cancelled by the client (stream cancel) is recorded as not finished.
      await closeExportLog(db, exportId, { rows: count, truncated, failed: failed || !finished }, { requestId, userId: ctx.user_id ?? "", kind });
      log("info", "reports.export", {
        request_id: requestId,
        user_id: ctx.user_id,
        export_id: exportId,
        kind,
        locale,
        filters: loggableFilters(filters),
        rows: count,
        truncated,
        failed,
        cancelled: !finished,
        duration_ms: Date.now() - started,
      });
    }
    if (truncated) yield csvRow([csvNote(locale, "truncated", cap)]);
    if (failed) yield csvRow([csvNote(locale, "incomplete")]);
  }

  const encoder = new TextEncoder();
  const iterator = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });

  const day = kind === "tracking" && typeof filters.date === "string" ? filters.date : cairoToday(now);
  return new Response(body, {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="honest-${kind.replace("_", "-")}-${day}.csv"`,
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}
