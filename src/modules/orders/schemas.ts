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

/**
 * One draft save as the device fixed it (offline-logic.ts buildDraftPayload). The
 * same payload is sent directly or replayed from the offline queue, so it is
 * strict: an unknown key — a price, a discount, a total — is rejected.
 */
export const draftPayloadSchema = z.strictObject({
  /** Generated on the device: the creating call and its replays share it. */
  order_id: id,
  customer_id: id,
  lines: z.array(draftLineSchema).min(1).max(MAX_LINES),
  notes: z.string().trim().max(1000).nullable(),
  visit_id: id.nullable(),
  /** The draft version this save is based on (optimistic concurrency); null for a new draft. */
  version: z.number().int().min(1).nullable(),
});
export type DraftPayloadInput = z.infer<typeof draftPayloadSchema>;

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
