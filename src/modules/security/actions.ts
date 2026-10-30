"use server";

import { revalidatePath } from "next/cache";
import { log } from "@/lib/log";
import { getRequestId } from "@/lib/request-id";
import { createClient } from "@/lib/supabase/server";
import { authErrorKey, defaultFactorName, isSafeQrDataUrl, isStepUpAuthError, stepUpFactor } from "./logic";
import { toFactorRow } from "./queries";
import { enrolSchema, factorSchema, formToFields, stepUpSchema, verifyEnrolmentSchema } from "./schemas";
import type { EnrolResult, SecurityErrorKey, SecurityResult } from "./types";

/**
 * MFA (TOTP) mutations, run on the server with the signed-in user's session
 * cookie (no browser Supabase client is needed). Supabase Auth only ever acts on
 * the caller's own factors; a factor id from the form is untrusted and Auth
 * rejects ids that are not the caller's. After a successful verification the
 * session is re-issued at aal2 and @supabase/ssr writes the new cookies.
 */

const ACCOUNT_PAGE = "/[locale]/account/security";
const DEFAULT_NAME = "Authenticator app";
const ISSUER = "Honest OS";

const failed = (messageKey: SecurityErrorKey): { ok: false; messageKey: SecurityErrorKey } => ({ ok: false, messageKey });

async function logAuthError(event: string, error: { code?: string; message?: string; status?: number } | unknown) {
  const e = (error ?? {}) as { code?: string; message?: string; status?: number };
  log("warn", event, { requestId: await getRequestId(), code: e.code, status: e.status, detail: e.message });
}

/**
 * Starts enrolment of a new TOTP factor and returns its QR code and secret.
 * Abandoned unverified TOTP factors of this user are removed first, so retries
 * never pile up half-enrolled factors (Supabase limits the number per user).
 */
export async function startTotpEnrolment(form: FormData): Promise<EnrolResult> {
  const parsed = enrolSchema.safeParse(formToFields(form, ["friendly_name"]));
  if (!parsed.success) return failed("VALIDATION");
  const supabase = await createClient();
  try {
    const { data: listed, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      await logAuthError("security.enrol_list_failed", listError);
      return failed(authErrorKey(listError));
    }
    const totp = listed.all.filter((f) => f.factor_type === "totp").map(toFactorRow);
    for (const stale of totp.filter((f) => f.status === "unverified")) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: stale.id });
      if (error) await logAuthError("security.enrol_cleanup_failed", error);
    }
    const friendlyName =
      parsed.data.friendly_name ?? defaultFactorName(DEFAULT_NAME, totp.filter((f) => f.status === "verified").map((f) => f.friendly_name));

    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName, issuer: ISSUER });
    if (error) {
      await logAuthError("security.enrol_failed", error);
      return failed(authErrorKey(error));
    }
    if (!isSafeQrDataUrl(data.totp.qr_code)) {
      await logAuthError("security.enrol_bad_qr", { message: "unexpected QR code format" });
      return failed("UNKNOWN");
    }
    return { ok: true, factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
  } catch (cause) {
    await logAuthError("security.enrol_failed", cause);
    return failed("UNAVAILABLE");
  }
}

/** Confirms a new factor with the first code from the app (challenge, then verify). */
export async function confirmTotpEnrolment(form: FormData): Promise<SecurityResult> {
  const parsed = verifyEnrolmentSchema.safeParse(formToFields(form, ["factor_id", "code"]));
  if (!parsed.success) return failed(parsed.error.issues.some((i) => i.path[0] === "code") ? "INVALID_CODE" : "VALIDATION");
  const { factor_id: factorId, code } = parsed.data;
  const supabase = await createClient();
  try {
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
    if (challengeError) {
      await logAuthError("security.enrol_challenge_failed", challengeError);
      return failed(authErrorKey(challengeError));
    }
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
    if (error) {
      await logAuthError("security.enrol_verify_failed", error);
      return failed(authErrorKey(error));
    }
  } catch (cause) {
    await logAuthError("security.enrol_verify_failed", cause);
    return failed("UNAVAILABLE");
  }
  revalidatePath(ACCOUNT_PAGE, "page");
  return { ok: true };
}

/** Abandons an enrolment that was started but never confirmed. */
export async function cancelTotpEnrolment(form: FormData): Promise<SecurityResult> {
  const parsed = factorSchema.safeParse(formToFields(form, ["factor_id"]));
  if (!parsed.success) return failed("VALIDATION");
  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factor_id });
    if (error) {
      await logAuthError("security.enrol_cancel_failed", error);
      return failed(authErrorKey(error));
    }
  } catch (cause) {
    await logAuthError("security.enrol_cancel_failed", cause);
    return failed("UNAVAILABLE");
  }
  revalidatePath(ACCOUNT_PAGE, "page");
  return { ok: true };
}

/**
 * Removes a factor. Supabase only lets an aal2 session remove a verified factor;
 * an aal1 session gets `mfaRequired`, so the step-up prompt verifies and retries.
 */
export async function removeFactor(_prev: SecurityResult | null, form: FormData): Promise<SecurityResult> {
  const parsed = factorSchema.safeParse(formToFields(form, ["factor_id"]));
  if (!parsed.success) return failed("VALIDATION");
  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: parsed.data.factor_id });
    if (error) {
      if (isStepUpAuthError(error)) return { ok: false, messageKey: "STEP_UP_FIRST", mfaRequired: true };
      await logAuthError("security.unenrol_failed", error);
      return failed(authErrorKey(error));
    }
    // Re-issue the session so its aal reflects the remaining factors (best-effort).
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) await logAuthError("security.unenrol_refresh_failed", refreshError);
  } catch (cause) {
    await logAuthError("security.unenrol_failed", cause);
    return failed("UNAVAILABLE");
  }
  revalidatePath(ACCOUNT_PAGE, "page");
  return { ok: true };
}

/**
 * Step-up: verifies a code from the user's authenticator app against their
 * oldest verified TOTP factor (challengeAndVerify). On success this session is
 * aal2 and the caller retries the action that returned MFA_REQUIRED.
 */
export async function verifyStepUp(form: FormData): Promise<SecurityResult> {
  const parsed = stepUpSchema.safeParse(formToFields(form, ["code"]));
  if (!parsed.success) return failed("INVALID_CODE");
  const supabase = await createClient();
  try {
    const { data: listed, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      await logAuthError("security.stepup_list_failed", listError);
      return failed(authErrorKey(listError));
    }
    const factor = stepUpFactor(listed.all.filter((f) => f.factor_type === "totp").map(toFactorRow));
    if (!factor) return failed("NO_FACTOR");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: parsed.data.code });
    if (error) {
      await logAuthError("security.stepup_failed", error);
      return failed(authErrorKey(error));
    }
  } catch (cause) {
    await logAuthError("security.stepup_failed", cause);
    return failed("UNAVAILABLE");
  }
  revalidatePath(ACCOUNT_PAGE, "page");
  return { ok: true };
}
