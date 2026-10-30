import { z } from "zod";
import { isIsoDate, MAX_PERIOD_DAYS, daysBetween } from "./logic";
import { KPI_CODES } from "./types";

/**
 * Input validation for dashboard URLs and the target form. These reject malformed
 * input early; scope, permissions and every number are decided again in Postgres.
 */

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
const isoDate = z.string().refine(isIsoDate, "invalid date");

/** `?employee=` on /dashboard: a valid id or nothing (the DB refuses one outside scope). */
export function parseEmployeeParam(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && id.safeParse(v).success ? v : null;
}

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

export const TARGET_SUBJECTS = ["employee", "role", "territory"] as const;

/** The target form. The subject id must match the chosen subject kind. */
export const targetSchema = z
  .object({
    target_id: id,
    kpi_code: z.enum(KPI_CODES),
    subject: z.enum(TARGET_SUBJECTS),
    employee_id: id.optional(),
    role_id: id.optional(),
    territory_id: id.optional(),
    period_start: isoDate,
    period_end: isoDate,
    target_value: z.coerce.number().min(0).max(999_999_999_999.99),
  })
  .superRefine((v, ctx) => {
    const subjectId = { employee: v.employee_id, role: v.role_id, territory: v.territory_id }[v.subject];
    if (!subjectId) ctx.addIssue({ code: "custom", path: [`${v.subject}_id`], message: "required" });
    if (v.period_end < v.period_start || daysBetween(v.period_start, v.period_end) > MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: "custom", path: ["period_end"], message: "invalid period" });
    }
  });
export type TargetInput = z.infer<typeof targetSchema>;
