/**
 * Shapes used by the account security (MFA) screens and the step-up helpers.
 * Factor rows come from Supabase Auth (`supabase.auth.mfa.listFactors()`); the
 * MFA policy comes from `api.my_mfa_status()` (supabase/migrations/20261103000600_mfa_step_up.sql).
 */

/** Keys under `security.errors.*` (both locales). */
export const SECURITY_ERROR_KEYS = [
  "INVALID_CODE",
  "CODE_EXPIRED",
  "NO_FACTOR",
  "FACTOR_NOT_FOUND",
  "TOO_MANY_FACTORS",
  "NAME_TAKEN",
  "TOTP_DISABLED",
  "STEP_UP_FIRST",
  "RATE_LIMITED",
  "VALIDATION",
  "UNAVAILABLE",
  "UNKNOWN",
] as const;
export type SecurityErrorKey = (typeof SECURITY_ERROR_KEYS)[number];

export type FactorStatus = "verified" | "unverified";

export interface FactorRow {
  id: string;
  friendly_name: string | null;
  status: FactorStatus;
  created_at: string;
}

/** `api.my_mfa_status()`. */
export interface MfaStatus {
  /** security.mfa_enforced: sensitive commands refuse sessions below aal2. */
  enforced: boolean;
  /** The session's JWT `aal` claim (null when absent). */
  aal: string | null;
  /** Permission codes the caller holds that need aal2 when enforced. */
  required_permissions: string[];
}

export type SecurityResult = { ok: true } | { ok: false; messageKey: SecurityErrorKey; mfaRequired?: true };

/** A started enrolment: the QR code and secret are shown once, never stored by us. */
export type EnrolResult =
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false; messageKey: SecurityErrorKey };

/**
 * Any action result that can carry the step-up flag. Module actions add
 * `mfaRequired: true` to a failed result (see `withMfaFlag` in logic.ts) and the
 * client hook `useStepUpAction` reacts to it.
 */
export type StepUpAware = { ok: false; mfaRequired?: boolean } | { ok: true } | null | undefined;
