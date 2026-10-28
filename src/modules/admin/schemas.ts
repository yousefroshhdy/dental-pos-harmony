import { z } from "zod";
import { SCOPES } from "@/lib/authz/can";
import type { TranslatedCode } from "@/lib/errors";

/**
 * Input validation for the admin Server Actions. These only reject malformed
 * input early; every rule (permissions, escalation ceiling, owner protection)
 * is enforced again by the api.* command in Postgres.
 */

/** FormData → plain object: strings trimmed, empty strings and files dropped. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

/** Egyptian phone → E.164 (`+20…`), matching the core.phone_e164 domain. Returns null if invalid. */
export function normalizeEgyptPhone(raw: string): string | null {
  let s = raw.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  else if (s.startsWith("0")) s = `+20${s.slice(1)}`;
  else if (s.startsWith("20")) s = `+${s}`;
  return /^\+20(1[0125][0-9]{8}|[2-9][0-9]{7,8})$/.test(s) ? s : null;
}

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
const reason = z.string().trim().min(3).max(500);
const locale = z.enum(["ar", "en"]);
const permissionCode = z.string().regex(/^[a-z_]+\.[a-z_]+\.[a-z_]+$/);

export const suspendUserSchema = z.object({ user_id: id, reason });
export const reactivateUserSchema = z.object({ user_id: id, reason });

export const grantRoleSchema = z.object({
  user_id: id,
  role_id: id,
  territory_id: id.optional(),
  reason,
});

export const revokeRoleSchema = z.object({
  user_role_id: id,
  /** Only used to refresh the right page; the command derives the user from the assignment. */
  user_id: id,
  reason,
});

export const createRoleSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  name_en: z.string().min(2).max(120),
  name_ar: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  locale,
});

export const setRolePermissionSchema = z.object({
  role_id: id,
  permission: permissionCode,
  scope: z.enum(SCOPES),
  // Empty = no limit (NULL). Whether the permission takes a limit is checked by the DB.
  limit: z.preprocess((v) => (v === undefined ? undefined : Number(v)), z.number().nonnegative().max(999_999_999_999.99).optional()),
});

export const removeRolePermissionSchema = z.object({ role_id: id, permission: permissionCode });

/** Retry support: ids of what a previous partial run already created. Not an authorization input. */
export const inviteResumeSchema = z.object({
  resume_employee_id: id.optional(),
  resume_user_id: id.optional(),
});

export const inviteUserSchema = inviteResumeSchema.extend({
  employee_no: z.string().min(1).max(40),
  full_name_en: z.string().min(2).max(160),
  full_name_ar: z.string().max(160).optional(),
  job_title: z.string().min(2).max(120),
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  phone: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const e164 = normalizeEgyptPhone(v);
      if (!e164) {
        ctx.addIssue({ code: "custom", message: "invalid Egyptian phone number" });
        return z.NEVER;
      }
      return e164;
    }),
  locale,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/** Field names that failed validation (first path segment), for aria-invalid hints. */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}

/** Which errors.* message to show for a validation failure. */
export function validationMessageKey(error: z.ZodError): TranslatedCode {
  return invalidFieldsOf(error).includes("reason") ? "REASON_REQUIRED" : "VALIDATION";
}
