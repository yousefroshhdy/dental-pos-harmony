import { z } from "zod";
import { MAX_LINES, MAX_QUANTITY } from "./logic";

/**
 * Input validation for the orders Server Actions. These only reject malformed
 * input early; permission, scope, status and pricing are decided again by the
 * api.* command in Postgres.
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
const locale = z.enum(["ar", "en"]);
const reason = z.string().trim().min(3).max(500);

/**
 * One builder line. Strict: the client sends a variant id and a whole quantity,
 * nothing else — never a price, discount, tax or total (CLAUDE.md rule 7).
 */
export const draftLineSchema = z.strictObject({
  variant_id: id,
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});

const linesJson = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "lines must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(draftLineSchema).min(1).max(MAX_LINES));

export const saveDraftSchema = z.object({
  /** Generated on the device: retrying the first save is a replay, not a second order. */
  order_id: id,
  customer_id: id,
  lines: linesJson,
  notes: z.string().max(1000).optional(),
  visit_id: id.optional(),
  /** Current version of an existing draft (optimistic concurrency); absent for a new draft. */
  version: z.coerce.number().int().min(1).optional(),
  locale,
});
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

export const orderRefSchema = z.object({ order_id: id, locale });
export const orderReasonSchema = orderRefSchema.extend({ reason });
export const reserveSchema = orderRefSchema.extend({ warehouse_id: id });
export const fulfilSchema = orderRefSchema.extend({
  /** Generated on the device once per fulfilment attempt; a retry with the same key is a replay. */
  idempotency_key: z.string().min(8).max(100).regex(/^[A-Za-z0-9-]+$/),
});

export const searchSchema = z.string().max(200);

/** Field names that failed validation (first path segment). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
