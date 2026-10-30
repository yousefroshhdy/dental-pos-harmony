import { z } from "zod";
import { isMonthKey, kindMatchesSign, parseSignedAmount } from "./logic";
import { ADJUSTMENT_KINDS } from "./types";

/**
 * Input validation for commission URLs and forms. These reject malformed input early;
 * permission, scope, period state and every amount are decided again in Postgres.
 */

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
const month = z.string().refine(isMonthKey, "invalid month");

/** `?employee=`: a valid id or nothing (RLS returns nothing for one outside the scope). */
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

/** Recalculate or close one month. */
export const periodActionSchema = z.object({ period: month });

export const adjustmentSchema = z
  .object({
    employee_id: id,
    period: month,
    amount: z.string().transform((raw, ctx) => {
      const n = parseSignedAmount(raw);
      if (n === null) {
        ctx.addIssue({ code: "custom", message: "invalid amount" });
        return z.NEVER;
      }
      return n;
    }),
    kind: z.enum(ADJUSTMENT_KINDS),
    reason: z.string().min(3).max(500),
    idempotency_key: id,
  })
  .refine((v) => kindMatchesSign(v.kind, v.amount), { message: "sign does not match kind", path: ["amount"] });

export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

/** Field names of a failed parse (to pick the most helpful message). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
