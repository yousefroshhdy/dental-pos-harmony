import { z } from "zod";
import { cairoLocalToIso, normalizeEgyptPhone, parseTags } from "./logic";
import {
  CUSTOMER_KINDS,
  CUSTOMER_SOURCES,
  LIFECYCLE_STAGES,
  MANUAL_ACTIVITY_TYPES,
  OPPORTUNITY_STAGES,
} from "./types";

/**
 * Input validation for the CRM Server Actions and list filters. These reject
 * malformed input early; every rule (permissions, scope, duplicates, state
 * machines) is enforced again by the api.* command in Postgres.
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

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const locale = z.enum(["ar", "en"]);

/** Egyptian phone in any common spelling → E.164 (`+20…`). */
const e164 = z.string().transform((v, ctx) => {
  const normalized = normalizeEgyptPhone(v);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "invalid Egyptian phone number" });
    return z.NEVER;
  }
  return normalized;
});

const customerFields = {
  doctor_name: z.string().max(160).optional(),
  clinic_name: z.string().max(160).optional(),
  display_name: z.string().max(200).optional(),
  kind: z.enum(CUSTOMER_KINDS).default("clinic"),
  specialty_code: code.optional(),
  phone_primary: e164,
  phone_secondary: e164.optional(),
  email: z.email().max(254).optional(),
  address_line: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  governorate_code: z
    .string()
    .regex(/^[A-Za-z]{2}-[A-Za-z]{1,4}$/)
    .transform((v) => v.toUpperCase()),
  tags: z
    .string()
    .max(500)
    .optional()
    .transform((v) => parseTags(v)),
  notes: z.string().max(2000).optional(),
};

const needsAName = (v: { doctor_name?: string; clinic_name?: string }) => Boolean(v.doctor_name || v.clinic_name);
const nameIssue = { message: "doctor_name or clinic_name is required", path: ["clinic_name"] };

export const createCustomerSchema = z
  .object({
    ...customerFields,
    source: z.enum(CUSTOMER_SOURCES).default("field"),
    /** Idempotency key generated when the form was rendered: a double submit replays. */
    client_ref: id,
    /** Set when the user confirmed the possible-duplicate warning. */
    confirm_duplicates: z.literal("1").optional(),
    locale,
  })
  .refine(needsAName, nameIssue);
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    ...customerFields,
    customer_id: id,
    version: z.coerce.number().int().positive(),
    lifecycle_stage: z.enum(LIFECYCLE_STAGES).optional(),
    locale,
  })
  .refine(needsAName, nameIssue);
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const logActivitySchema = z.object({
  customer_id: id,
  type: z.enum(MANUAL_ACTIVITY_TYPES),
  summary: z.string().min(2).max(2000),
  /** Cairo wall-clock time from <input type="datetime-local">; empty = now. */
  occurred_at: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const iso = cairoLocalToIso(v);
      if (!iso) {
        ctx.addIssue({ code: "custom", message: "invalid date" });
        return z.NEVER;
      }
      return iso;
    }),
});

export const reassignSchema = z.object({
  customer_id: id,
  to_employee_id: id,
  reason: z.string().min(3).max(500),
});

export const setLocationSchema = z.object({
  customer_id: id,
  latitude: z.coerce.number().min(21.5).max(32),
  longitude: z.coerce.number().min(24.5).max(37.5),
  /** Browser-reported accuracy in metres; checked again before submit. Not stored by the command. */
  accuracy_m: z.coerce.number().nonnegative().max(100_000),
});

export const createOpportunitySchema = z.object({
  customer_id: id,
  title: z.string().min(2).max(200),
  // An estimate the rep types in; never a price the server relies on.
  expected_value: z.preprocess(
    (v) => (v === undefined ? undefined : Number(String(v).replace(/[,،\s]/g, ""))),
    z.number().nonnegative().max(999_999_999_999.99).optional(),
  ),
  expected_close_date: z.iso.date().optional(),
  locale,
});

export const moveOpportunitySchema = z
  .object({
    opportunity_id: id,
    stage: z.enum(OPPORTUNITY_STAGES),
    lost_reason: z.string().max(500).optional(),
  })
  .refine((v) => v.stage !== "lost" || (v.lost_reason?.length ?? 0) >= 3, {
    message: "a lost opportunity needs a reason",
    path: ["lost_reason"],
  });

// ---------------------------------------------------------------------------
// List filters (URL search params). Invalid values are dropped, never fatal.
// ---------------------------------------------------------------------------

const optionalParam = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const customerListParamsSchema = z.object({
  q: optionalParam(z.string().trim().max(80)),
  stage: optionalParam(z.enum(LIFECYCLE_STAGES)),
  territory: optionalParam(id),
  specialty: optionalParam(code),
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
});
export type CustomerListParams = z.infer<typeof customerListParamsSchema>;

/** Next.js searchParams (string | string[]) → first value per key. */
export function firstValues(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined && first !== "") out[k] = first;
  }
  return out;
}

/** Field names that failed validation (first path segment), for aria-invalid hints. */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
