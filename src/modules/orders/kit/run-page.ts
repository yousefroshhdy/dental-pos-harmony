import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import type { Page } from "./paging";

type PageQuery = PromiseLike<{ data: unknown; count: number | null; error: { code?: string; message?: string; details?: string } | null }>;

/**
 * Runs one `select(…, { count: "exact" }).range(…)` read of an api view and returns
 * the rows with the total that matches. Errors are mapped and logged the way each
 * module's own `run` helper does (`<scope>.read_failed`), never thrown.
 */
export async function runPage<T>(scope: string, view: string, query: PageQuery): Promise<Result<Page<T>>> {
  try {
    const { data, count, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", `${scope}.read_failed`, { view, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok({ rows: (data ?? []) as T[], total: count ?? 0 });
  } catch (cause) {
    log("error", `${scope}.read_failed`, { view, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}
