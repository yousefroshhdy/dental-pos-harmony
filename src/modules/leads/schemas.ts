import { z } from "zod";
import { LEAD_FILTERS, MANUAL_LEAD_STATUSES } from "./types";

/**
 * Input validation for the leads pages and actions. Rejects malformed input early; the database
 * re-checks every permission, scope and rule (api.* commands, RLS).
 */

const id = z.guid();
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.preprocess((v) => (v === "" ? undefined : v), text(max).optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const leadStatusSchema = z.object({ lead_id: id, status: z.enum(MANUAL_LEAD_STATUSES) });

export const leadNotesSchema = z.object({ lead_id: id, notes: optionalText(2000) });

export const leadPlanSchema = z.object({ lead_id: id, date: isoDate, plan: z.enum(["add", "remove"]).default("add") });

/** First visit: the rep's own record of the clinic (doctor or clinic name required, phone optional). */
export const convertLeadSchema = z
  .object({
    lead_id: id,
    client_ref: id,
    doctor_name: optionalText(120),
    clinic_name: optionalText(160),
    phone: optionalText(32),
    specialty_code: optionalText(40),
    governorate_code: text(10).min(2),
    city: optionalText(80),
    notes: optionalText(2000),
  })
  .refine((v) => Boolean(v.doctor_name || v.clinic_name), { path: ["doctor_name"], message: "name_required" });

export const reassignLeadsSchema = z.object({
  lead_ids: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(id).min(1).max(500)),
  employee_id: id,
  reason: text(500).min(3),
});

/** Move all open leads of one rep to another (team page). */
export const bulkReassignSchema = z.object({ from_employee_id: id, employee_id: id, reason: text(500).min(3) });

export const runNowSchema = z.object({ employee_id: id });

export const radiusSchema = z.object({ employee_id: id, radius_km: z.coerce.number().min(0.5).max(50) });

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

export interface LeadListParams {
  filter: (typeof LEAD_FILTERS)[number];
  page: number;
  view: "list" | "map";
  /** Managers: one rep's leads. */
  rep?: string;
}

/** /leads search params; invalid values fall back to the defaults. */
export function parseLeadListParams(params: Record<string, string | string[] | undefined>): LeadListParams {
  const f = z.enum(LEAD_FILTERS).safeParse(first(params.filter));
  const p = z.coerce.number().int().min(1).max(500).safeParse(first(params.page));
  const v = z.enum(["list", "map"]).safeParse(first(params.view));
  const r = id.safeParse(first(params.rep));
  return {
    filter: f.success ? f.data : "open",
    page: p.success ? p.data : 1,
    view: v.success ? v.data : "list",
    ...(r.success ? { rep: r.data } : {}),
  };
}

/** FormData → plain object: strings trimmed, empty strings dropped; repeated keys become arrays. */
export function formToObject(form: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "") continue;
    const prev = out[key];
    out[key] = prev === undefined ? trimmed : Array.isArray(prev) ? [...prev, trimmed] : [prev, trimmed];
  }
  return out;
}
