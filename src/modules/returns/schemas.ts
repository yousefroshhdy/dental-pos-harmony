import { z } from "zod";
import { REASON_CODES } from "./types";

/**
 * Input validation for the returns Server Actions. These only reject malformed
 * input early; permission, scope, state and quantities are decided again by the
 * api.* command in Postgres. The client sends ids, whole quantities, reason
 * codes and notes — never a price, VAT or total.
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
/** Generated on the device once per attempt; a retry with the same key is a replay. */
const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9-]+$/);

/** One line exactly as api.request_return accepts it (strict: no other keys, ever). */
export const requestLineSchema = z.strictObject({
  order_item_id: id,
  lot_id: id,
  quantity: z.number().int().positive().max(100_000),
  reason_code: z.enum(REASON_CODES),
});

const linesJson = z.string().transform((raw, ctx) => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid json" });
    return z.NEVER;
  }
});

export const requestReturnSchema = z.object({
  order_id: id,
  locale,
  client_ref: id,
  notes: z.string().trim().max(1000).optional(),
  lines: linesJson.pipe(z.array(requestLineSchema).min(1).max(100)),
});

export const receiveReturnSchema = z.object({
  return_id: id,
  warehouse_id: id,
  idempotency_key: idempotencyKey,
});

export const creditReturnSchema = z.object({
  return_id: id,
  idempotency_key: idempotencyKey,
});

/** api.cancel_return: who may cancel, and in which state, is decided in Postgres. */
export const cancelReturnSchema = z.object({
  return_id: id,
  reason: z.string().trim().min(3).max(500),
  idempotency_key: idempotencyKey,
});
