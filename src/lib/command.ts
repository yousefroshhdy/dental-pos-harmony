import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "./errors";
import { log } from "./log";
import { getRequestId } from "./request-id";
import { withRetry } from "./retry";
import { createClient } from "./supabase/server";

/**
 * The single path from server code to Postgres commands (docs/API_CONTRACTS.md §1).
 * Calls `api.<name>(args)` as the signed-in user, retries transient failures,
 * maps errors to AppError and logs with a request id.
 *
 * Never pass prices, totals, user ids or scopes as trusted input — the
 * database derives them.
 */
export async function callCommand<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<Result<T>> {
  const requestId = await getRequestId();
  const supabase = await createClient();
  const started = Date.now();

  const result = await withRetry<T>(async () => {
    try {
      const { data, error } = await supabase.rpc(name, args);
      if (error) return fail(parseDbError(error, requestId));
      return ok(data as T);
    } catch (cause) {
      return fail(networkError(cause, requestId));
    }
  });

  if (result.ok) {
    log("info", "command.ok", { command: name, requestId, ms: Date.now() - started });
  } else {
    log(result.error.code === "UNKNOWN" || result.error.code === "UNAVAILABLE" ? "error" : "warn", "command.failed", {
      command: name,
      requestId,
      code: result.error.code,
      detail: result.error.detail,
      ms: Date.now() - started,
    });
  }
  return result;
}
