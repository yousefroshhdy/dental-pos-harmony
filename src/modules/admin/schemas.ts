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

// ---------------------------------------------------------------------------
// Admin console v2: settings, employees, territories
// ---------------------------------------------------------------------------

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits → ASCII, Arabic decimal separator → ".". */
export function normalizeDigits(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".");
}

const optionalReason = z.string().trim().max(500).optional();
/** A Postgres timestamptz echoed back by the form (optimistic concurrency token). */
const timestamp = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "invalid timestamp");
const isoDate = z.iso.date();

export const SETTING_TYPES = ["integer", "number", "boolean", "text", "enum", "enum_array", "time_range"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

export const updateSettingSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** Only tells the server how to read the form; api.update_setting validates against the definition. */
  value_type: z.enum(SETTING_TYPES),
  reason: optionalReason,
  expected_updated_at: timestamp.optional(),
});

export interface SettingFormInput {
  value?: string;
  values?: string[];
  start?: string;
  end?: string;
}

const HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * The JSON value to send for a setting of `type`, read from its form fields. Only the shape is
 * checked here; ranges, allowed values and the owner-only rule are enforced by the database.
 */
export function parseSettingValue(type: SettingType, input: SettingFormInput): { ok: true; value: unknown } | { ok: false } {
  const raw = normalizeDigits(input.value ?? "").trim();
  switch (type) {
    case "integer":
      return /^-?\d{1,12}$/.test(raw) ? { ok: true, value: Number(raw) } : { ok: false };
    case "number":
      return /^-?\d{1,12}(\.\d{1,2})?$/.test(raw) ? { ok: true, value: Number(raw) } : { ok: false };
    case "boolean":
      return raw === "true" || raw === "false" ? { ok: true, value: raw === "true" } : { ok: false };
    case "text":
    case "enum":
      return raw !== "" && raw.length <= 500 ? { ok: true, value: raw } : { ok: false };
    case "enum_array": {
      const values = (input.values ?? []).map((v) => v.trim()).filter(Boolean);
      return values.every((v) => /^[a-z0-9_]{1,40}$/.test(v)) ? { ok: true, value: [...new Set(values)] } : { ok: false };
    }
    case "time_range": {
      const start = normalizeDigits(input.start ?? "").trim();
      const end = normalizeDigits(input.end ?? "").trim();
      return HH_MM.test(start) && HH_MM.test(end) ? { ok: true, value: { start, end } } : { ok: false };
    }
  }
}

const optionalEgyptPhone = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const e164 = normalizeEgyptPhone(normalizeDigits(v));
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "invalid Egyptian phone number" });
      return z.NEVER;
    }
    return e164;
  });

const employeeFields = {
  full_name_en: z.string().min(2).max(160),
  full_name_ar: z.string().max(160).optional(),
  job_title: z.string().min(2).max(120),
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase())
    .optional(),
  phone: optionalEgyptPhone,
  department_id: id.optional(),
  office_id: id.optional(),
  manager_id: id.optional(),
  hired_on: isoDate.optional(),
};

export const createEmployeeSchema = z.object({ employee_no: z.string().min(1).max(40), ...employeeFields, locale });
export const updateEmployeeSchema = z.object({ employee_id: id, expected_updated_at: timestamp, ...employeeFields });

export const EMPLOYMENT_STATUS_VALUES = ["active", "on_leave", "suspended", "terminated"] as const;
export const employmentStatusSchema = z.object({ employee_id: id, status: z.enum(EMPLOYMENT_STATUS_VALUES), reason });

export const assignTerritorySchema = z.object({
  employee_id: id,
  territory_id: id,
  assignment: z.enum(["member", "manager"]),
});
export const endTerritorySchema = z.object({ employee_territory_id: id, employee_id: id, reason: optionalReason });

const territoryName = z.string().min(1).max(120);
export const createTerritorySchema = z.object({
  code: z
    .string()
    .transform((c) => c.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/)),
  name_en: territoryName,
  name_ar: territoryName,
  parent_id: id.optional(),
});
export const renameTerritorySchema = z.object({ territory_id: id, name_en: territoryName, name_ar: territoryName });
export const moveTerritorySchema = z.object({
  territory_id: id,
  /** "root" = become a region. */
  parent_id: z.union([id, z.literal("root")]).transform((v) => (v === "root" ? null : v)),
  reason: optionalReason,
});
export const territoryActiveSchema = z.object({
  territory_id: id,
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
  reason,
});
const governorateCode = z.string().regex(/^EG-[A-Z]{1,4}$/);
const city = z.string().max(80).optional();
export const coverageSchema = z.object({ territory_id: id, governorate_code: governorateCode, city });
export const removeCoverageSchema = z.object({ governorate_code: governorateCode, city });

/** Field names that failed validation (first path segment), for aria-invalid hints. */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}

/** Which errors.* message to show for a validation failure. */
export function validationMessageKey(error: z.ZodError): TranslatedCode {
  return invalidFieldsOf(error).includes("reason") ? "REASON_REQUIRED" : "VALIDATION";
}
