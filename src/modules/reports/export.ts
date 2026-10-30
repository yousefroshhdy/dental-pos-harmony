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
  if (error.code === "PERMISSION_DENIED") return 403;
  if (error.code === "VALIDATION") return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "UNAVAILABLE") return 503;
  return 500;
}

function readError(cause: unknown): AppError {
  if (cause instanceof ExportReadError) return parseDbError(cause.dbError);
  return { code: "UNAVAILABLE", messageKey: "UNAVAILABLE", detail: cause instanceof Error ? cause.message : String(cause), retryable: false };
}

/** Filters for the log: values are ids, codes and dates; free-text search is redacted. */
function loggableFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, k === "q" && v ? "[redacted]" : v]));
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
  const rows = SOURCES[kind]({ db, ctx, filters, limit: cap + 1, now });

  // First batch before the response starts: errors become status codes.
  let first: IteratorResult<Row[]>;
  try {
    first = await rows.next();
  } catch (cause) {
    const error = readError(cause);
    log("warn", "reports.export_failed", { request_id: requestId, user_id: ctx.user_id, kind, code: error.code, detail: error.detail });
    return jsonError(statusFor(error), error.code === "PERMISSION_DENIED" ? "forbidden" : "export_failed", requestId);
  }

  const columns = columnsFor(kind, ctx);
  const started = Date.now();

  async function* chunks(): AsyncGenerator<string> {
    yield BOM + csvRow(headersFor(columns, locale));
    let count = 0;
    let truncated = false;
    let failed = false;
    let batch = first;
    try {
      while (!batch.done) {
        const room = cap - count;
        const take = batch.value.length > room ? batch.value.slice(0, room) : batch.value;
        if (take.length > 0) yield take.map((r) => csvRow(rowValues(columns, r, locale))).join("");
        count += take.length;
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
    } finally {
      await rows.return(undefined);
    }
    if (truncated) yield csvRow([csvNote(locale, "truncated", cap)]);
    if (failed) yield csvRow([csvNote(locale, "incomplete")]);
    // Audit trail until the database has an export event command (docs/AUTHORIZATION.md §2, level 7).
    log("info", "reports.export", {
      request_id: requestId,
      user_id: ctx.user_id,
      kind,
      locale,
      filters: loggableFilters(filters),
      rows: count,
      truncated,
      failed,
      duration_ms: Date.now() - started,
    });
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
