import type { AppError, Result } from "@/lib/errors";
import type { ConflictPayload, Json, JsonObject, SendError, SendResult } from "./types";

/**
 * Turns a `callCommand()` result into what a queued sender returns to the
 * browser. Use it in the server action behind a sender:
 *
 *   return toSendResult(await callCommand("visit_check_in", { p_visit_id: meta.id, ... }));
 *
 * Only the code, the translation key, the request id and a version-conflict
 * payload cross to the client; the developer `detail` text does not.
 */
export function toSendResult(result: Result<unknown>): SendResult {
  if (result.ok) return { ok: true, data: (result.data ?? null) as Json };
  return { ok: false, error: toSendError(result.error) };
}

export function toSendError(error: AppError): SendError {
  const conflict = versionConflictOf(error);
  return {
    code: error.code,
    messageKey: error.messageKey,
    // A unique-key race between two sends of the same client ref rolled back; the
    // next send returns the replayed answer (crm create_customer, see migration 20261029000200).
    retryable: error.retryable || (error.code === "CONFLICT" && /concurrent request used the same client_ref/i.test(error.detail)),
    // UNAVAILABLE without retryable = connection lost: the command may or may not have committed.
    ambiguous: error.code === "UNAVAILABLE" && !error.retryable,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

/** JSON objects embedded in an AppError detail ("SQLSTATE | message | details"). */
function detailObjects(detail: string): JsonObject[] {
  return detail
    .split(" | ")
    .filter((part) => part.trim().startsWith("{"))
    .flatMap((part) => {
      try {
        const value = JSON.parse(part) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? [value as JsonObject] : [];
      } catch {
        return [];
      }
    });
}

/**
 * A CONFLICT is a version conflict when the command reports the record's current
 * version: update_customer puts `current_version` in the error detail, save_order_draft
 * says "current version N" in the message. Other CONFLICTs (a client ref reused by
 * someone else) are plain business failures.
 */
export function versionConflictOf(error: Pick<AppError, "code" | "detail">): ConflictPayload | undefined {
  if (error.code !== "CONFLICT" && error.code !== "VERSION_CONFLICT") return undefined;
  const server = Object.assign({}, ...detailObjects(error.detail)) as JsonObject;
  const fromDetail = typeof server.current_version === "number" ? server.current_version : undefined;
  const fromMessage = /current version (\d+)|current (\d+)\)/i.exec(error.detail);
  const currentVersion = fromDetail ?? (fromMessage ? Number(fromMessage[1] ?? fromMessage[2]) : undefined);
  if (currentVersion === undefined && error.code !== "VERSION_CONFLICT") return undefined;
  return {
    ...(currentVersion !== undefined ? { currentVersion } : {}),
    ...(Object.keys(server).length ? { server } : {}),
  };
}
