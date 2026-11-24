import { z } from "zod";
import { LIFECYCLE_STAGES } from "@/modules/crm/types";
import { LAST_VISIT_FILTERS } from "./types";

/**
 * Input validation for the maps pages and actions. Rejects malformed input early; the
 * database re-checks every permission, scope and rule (api.* commands, RLS).
 */

const id = z.guid();
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => {
  const one = first(v);
  return one === "" || one === null ? undefined : one;
}, schema.optional());

/** /map search params. Invalid values are dropped (treated as "all"), never an error page. */
const filterShape = {
  rep: optional(id),
  territory: optional(id),
  stage: optional(z.enum(LIFECYCLE_STAGES)),
  overdue: optional(z.literal("1")),
  lastVisit: optional(z.enum(LAST_VISIT_FILTERS)),
};

export interface CustomerMapFilters {
  rep?: string;
  territory?: string;
  stage?: (typeof LIFECYCLE_STAGES)[number];
  overdue?: "1";
  lastVisit?: (typeof LAST_VISIT_FILTERS)[number];
}

export function parseCustomerMapFilters(params: Record<string, string | string[] | undefined>): CustomerMapFilters {
  const out: CustomerMapFilters = {};
  for (const [name, schema] of Object.entries(filterShape) as [keyof CustomerMapFilters, z.ZodType][]) {
    const parsed = schema.safeParse(params[name]);
    if (parsed.success && parsed.data !== undefined) (out as Record<string, unknown>)[name] = parsed.data;
  }
  return out;
}

/** FormData → plain object: strings trimmed, empty strings dropped. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

export const decideProposalSchema = z
  .object({
    proposal_id: id,
    decision: z.enum(["approve", "reject"]),
    note: z.string().max(500).optional(),
  })
  .refine((v) => v.decision === "approve" || (v.note !== undefined && v.note.trim() !== ""), {
    path: ["note"],
    message: "a reason is required to reject",
  });

const coordinate = (min: number, max: number) => z.coerce.number().refine((n) => Number.isFinite(n) && n >= min && n <= max);

/** A location chosen on the map (address search or dropped pin) by a crm.customer_location.verify holder. */
export const mapLocationSchema = z.object({
  customer_id: id,
  latitude: coordinate(21.5, 32.0),
  longitude: coordinate(24.5, 37.5),
  source: z.enum(["search", "pin"]),
});
