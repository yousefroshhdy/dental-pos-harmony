import { z } from "zod";
import { parseDay, parseProposalValue } from "./logic";
import { VISIT_CLASSES } from "./types";

/**
 * Input validation for the planning Server Actions. These only reject malformed input early;
 * permission, team scope, assignment, past days and duplicates are decided by the api.* command.
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
const day = z.string().refine((v) => parseDay(v) !== null, { message: "not a calendar day" });

/** Most visits per api.plan_visits call (the command refuses more). */
export const MAX_VISITS_PER_PLAN = 200;
/** api.generate_plan considers at most this many customers per call, most due first (audit 4 F2). */
export const GENERATE_MAX_CUSTOMERS = 1000;

export const addVisitSchema = z
  .object({
    employee_id: id.optional(),
    customer_id: id,
    date: day,
    client_ref: id,
  })
  .strict();

export const unplanSchema = z.object({ visit_id: id }).strict();

export const savePlanSchema = z
  .object({
    employee_id: id,
    client_ref: id,
    visits: z
      .array(z.object({ customer_id: id, date: day }).strict())
      .min(1)
      .max(MAX_VISITS_PER_PLAN),
  })
  .strict();

/** The checked proposals of the review form ("customerId|YYYY-MM-DD"), malformed values dropped. */
export function visitsFromForm(form: FormData, field = "visit"): { customer_id: string; date: string }[] {
  return form
    .getAll(field)
    .filter((v): v is string => typeof v === "string")
    .map(parseProposalValue)
    .filter((v): v is { customer_id: string; date: string } => v !== null);
}

export const setFrequencySchema = z
  .object({
    customer_id: id,
    visit_class: z.enum(VISIT_CLASSES),
  })
  .strict();
