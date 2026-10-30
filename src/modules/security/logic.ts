import type { FactorRow, MfaStatus, SecurityErrorKey } from "./types";

/**
 * Pure helpers for MFA (TOTP) enrolment and step-up. No I/O, so they are unit
 * tested directly (tests/unit/security-logic.test.ts).
 */

/** The business code `authz.require` raises (SQLSTATE 42501) when a session must step up to aal2. */
export const MFA_REQUIRED = "MFA_REQUIRED";

/** True for an AppError (or any `{ code }`) that asks for a second factor. */
export function isMfaRequired(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === MFA_REQUIRED;
}

/**
 * Error-mapping helper for other modules' Server Actions. Spread it into a failed
 * result so the client can offer the step-up prompt instead of a dead-end error:
 *
 *   const failed = (error: AppError) => ({ ok: false, messageKey: error.messageKey, requestId: error.requestId, ...mfaFlag(error) });
 */
export function mfaFlag(error: { code?: string | null } | null | undefined): { mfaRequired?: true } {
  return isMfaRequired(error) ? { mfaRequired: true } : {};
}

/** Adds `mfaRequired: true` to a failed result when `error` is MFA_REQUIRED. */
export function withMfaFlag<T extends { ok: false }>(result: T, error: { code?: string | null } | null | undefined): T & { mfaRequired?: true } {
  return { ...result, ...mfaFlag(error) };
}

/** Does an action state ask for step-up? (Client side; accepts any action result shape.) */
export function needsStepUp(state: unknown): boolean {
  if (typeof state !== "object" || state === null) return false;
  const s = state as { ok?: unknown; mfaRequired?: unknown; code?: unknown; error?: { code?: unknown } };
  if (s.ok !== false) return false;
  return s.mfaRequired === true || s.code === MFA_REQUIRED || s.error?.code === MFA_REQUIRED;
}

/** Normalises what a user types into a 6-digit TOTP code (spaces, dashes and Arabic-Indic digits allowed). */
export function normaliseTotpCode(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, "");
}

export const TOTP_CODE = /^[0-9]{6}$/;

/** Supabase Auth error codes → `security.errors.*`. Unknown codes fall back to UNKNOWN. */
const AUTH_ERROR_KEYS: Record<string, SecurityErrorKey> = {
  mfa_verification_failed: "INVALID_CODE",
  mfa_verification_rejected: "INVALID_CODE",
  mfa_challenge_expired: "CODE_EXPIRED",
  mfa_factor_not_found: "FACTOR_NOT_FOUND",
  too_many_enrolled_mfa_factors: "TOO_MANY_FACTORS",
  mfa_factor_name_conflict: "NAME_TAKEN",
  mfa_totp_enroll_not_enabled: "TOTP_DISABLED",
  mfa_totp_verify_not_enabled: "TOTP_DISABLED",
  insufficient_aal: "STEP_UP_FIRST",
  over_request_rate_limit: "RATE_LIMITED",
  over_email_send_rate_limit: "RATE_LIMITED",
  request_timeout: "UNAVAILABLE",
};

export function authErrorKey(error: { code?: string | null; status?: number | null } | null | undefined): SecurityErrorKey {
  if (!error) return "UNKNOWN";
  const mapped = error.code ? AUTH_ERROR_KEYS[error.code] : undefined;
  if (mapped) return mapped;
  if (error.status === 429) return "RATE_LIMITED";
  if (error.status === undefined || error.status === null || error.status >= 500) return "UNAVAILABLE";
  return "UNKNOWN";
}

/** Supabase refuses to remove a verified factor from an aal1 session: that is a step-up, not a failure. */
export function isStepUpAuthError(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "insufficient_aal";
}

/** Verified factors first, then oldest first (stable display order). */
export function sortFactors(factors: readonly FactorRow[]): FactorRow[] {
  return [...factors].sort((a, b) =>
    a.status === b.status ? a.created_at.localeCompare(b.created_at) : a.status === "verified" ? -1 : 1,
  );
}

export const verifiedFactors = (factors: readonly FactorRow[]) => factors.filter((f) => f.status === "verified");

/** The factor the step-up prompt challenges: the oldest verified TOTP factor. */
export function stepUpFactor(factors: readonly FactorRow[]): FactorRow | null {
  return sortFactors(verifiedFactors(factors))[0] ?? null;
}

/** "Authenticator app", then "Authenticator app 2", 3… — Supabase rejects duplicate names per user. */
export function defaultFactorName(base: string, existing: readonly (string | null)[]): string {
  const taken = new Set(existing.filter((n): n is string => Boolean(n)));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${Date.now()}`;
}

/** Only an inline SVG/PNG data URL from Supabase is rendered as the QR code image. */
export function isSafeQrDataUrl(url: string): boolean {
  return /^data:image\/(svg\+xml|png)[;,]/.test(url);
}

/** Groups the TOTP secret in fours for manual entry. */
export function formatSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

export type MfaStanding = "protected" | "verifyNow" | "enrolNeeded" | "optional";

/**
 * What the account page tells the user:
 *  - protected:   a verified factor and this session is aal2
 *  - verifyNow:   a verified factor, but this session is aal1 (sensitive actions will ask)
 *  - enrolNeeded: holds permissions that require MFA and has no verified factor
 *  - optional:    nothing requires MFA for this user and no factor yet
 */
export function mfaStanding(status: Pick<MfaStatus, "aal" | "required_permissions">, factors: readonly FactorRow[]): MfaStanding {
  const hasFactor = verifiedFactors(factors).length > 0;
  if (hasFactor) return status.aal === "aal2" ? "protected" : "verifyNow";
  return status.required_permissions.length > 0 ? "enrolNeeded" : "optional";
}
