import { z } from "zod";
import { normaliseTotpCode, TOTP_CODE } from "./logic";

/** Form inputs of the MFA screens. Supabase Auth re-checks everything server side. */

export function formValue(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export const totpCodeSchema = z
  .string()
  .transform(normaliseTotpCode)
  .pipe(z.string().regex(TOTP_CODE));

// Factor ids are Supabase uuids; z.guid() accepts any 8-4-4-4-12 hex id.
export const factorIdSchema = z.guid();

export const friendlyNameSchema = z
  .string()
  .trim()
  .max(60)
  .transform((v) => (v === "" ? undefined : v));

export const enrolSchema = z.object({ friendly_name: friendlyNameSchema.optional() });
export const verifyEnrolmentSchema = z.object({ factor_id: factorIdSchema, code: totpCodeSchema });
export const factorSchema = z.object({ factor_id: factorIdSchema });
export const stepUpSchema = z.object({ code: totpCodeSchema });

export function formToFields(form: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, formValue(form, k)]).filter(([, v]) => v !== ""));
}
