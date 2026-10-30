/**
 * Typed application errors. Postgres commands raise `CODE: message` with a
 * SQLSTATE (docs/ARCHITECTURE.md §8.1); this module turns those — and network
 * failures — into a stable shape the UI can translate. Raw SQL text never
 * reaches the user.
 */

/** Codes with a translation under `errors.*` in messages/{ar,en}.json. */
export const TRANSLATED_CODES = [
  "PERMISSION_DENIED",
  "ESCALATION_BLOCKED",
  "OWNER_ONLY",
  "SELF_GRANT_FORBIDDEN",
  "SELF_SUSPEND_FORBIDDEN",
  "LAST_OWNER",
  "OWNER_ROLE_PROTECTED",
  "NOT_FOUND",
  "INVALID_STATE",
  "VALIDATION",
  "DUPLICATE",
  "CONFLICT",
  "REASON_REQUIRED",
  "UNAVAILABLE",
  "MFA_REQUIRED",
  "RATE_LIMITED",
  "UNKNOWN",
] as const;
export type TranslatedCode = (typeof TRANSLATED_CODES)[number];

export interface AppError {
  /** Business code, e.g. INSUFFICIENT_STOCK. Always upper snake case. */
  code: string;
  /** Key under `errors.*` to show the user (falls back to UNKNOWN). */
  messageKey: TranslatedCode;
  /** Developer detail — log it, never render it. */
  detail: string;
  /** Safe to re-run automatically: the server rolled the attempt back (serialization failure / deadlock). */
  retryable: boolean;
  requestId?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(error: AppError): Result<T> => ({ ok: false, error });

/** Minimal shape of a PostgREST / Postgres error. */
export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

// Only states where the server certainly did NOT commit: serialization failure,
// deadlock, statement cancelled, too many connections, could not connect.
// (08006 "connection failure" is excluded — the commit status is unknown.)
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "57014", "53300", "08001"]);

const SQLSTATE_TO_CODE: Record<string, string> = {
  "42501": "PERMISSION_DENIED",
  P0002: "NOT_FOUND",
  "23505": "DUPLICATE",
  "23503": "VALIDATION",
  "23514": "VALIDATION",
  "22P02": "VALIDATION",
  "22023": "VALIDATION",
  "40001": "UNAVAILABLE",
  "40P01": "UNAVAILABLE",
  "57014": "UNAVAILABLE",
  "53300": "UNAVAILABLE",
  PGRST301: "PERMISSION_DENIED", // JWT expired / invalid
  PGRST202: "NOT_FOUND", // function not found in schema cache
};

const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,}):\s?/;

function toMessageKey(code: string): TranslatedCode {
  return (TRANSLATED_CODES as readonly string[]).includes(code) ? (code as TranslatedCode) : "UNKNOWN";
}

export function parseDbError(error: DbErrorLike, requestId?: string): AppError {
  const message = error.message ?? "";
  const sqlstate = error.code ?? "";
  const prefixed = CODE_PREFIX.exec(message)?.[1];
  const code = prefixed ?? SQLSTATE_TO_CODE[sqlstate] ?? "UNKNOWN";
  return {
    code,
    messageKey: toMessageKey(code),
    detail: [sqlstate, message, error.details].filter(Boolean).join(" | "),
    retryable: RETRYABLE_SQLSTATES.has(sqlstate),
    requestId,
  };
}

/**
 * A network failure is NOT auto-retried: the request may have committed before the
 * response was lost, and re-running a non-idempotent command would apply it twice
 * (audit #15). The user sees UNAVAILABLE and can retry deliberately; device
 * commands carry idempotency keys so a deliberate retry is safe.
 */
export function networkError(cause: unknown, requestId?: string): AppError {
  return {
    code: "UNAVAILABLE",
    messageKey: "UNAVAILABLE",
    detail: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    requestId,
  };
}

export function validationError(detail: string, requestId?: string): AppError {
  return { code: "VALIDATION", messageKey: "VALIDATION", detail, retryable: false, requestId };
}
