import { z } from "zod";
import { isDayKey, isMonthKey, kindMatchesSign, parseRatePct, parseSignedAmount } from "./logic";
import { ADJUSTMENT_KINDS, RATE_TARGETS } from "./types";

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

// ---------------------------------------------------------------------------
// Rate editor (owner). The server re-checks everything: permission, MFA, dates against
// the closed months, the target and the rate.
// ---------------------------------------------------------------------------
const day = z.string().refine(isDayKey, "invalid day");

/** `[planId]` route segment. */
export function parsePlanId(value: string): string | null {
  return id.safeParse(value).success ? value : null;
}

export const createPlanSchema = z.object({
  code: z
    .string()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/)),
  name: z.string().min(3).max(120),
});

/**
 * Set a rate (or, with `clear`, remove it) for the plan default, a brand, a category or a
 * product from a day on. The rate is a percentage 0–100 with at most 2 decimals.
 */
export const rateSchema = z
  .object({
    plan_id: id,
    target: z.enum(RATE_TARGETS),
    target_id: id.optional(),
    rate: z.string().optional(),
    clear: z.literal("1").optional(),
    effective_from: day,
    note: z.string().max(500).optional(),
    idempotency_key: id,
  })
  .refine((v) => (v.target === "default") === (v.target_id === undefined), { message: "target id", path: ["target_id"] })
  .transform((v, ctx) => {
    if (v.clear === "1") return { ...v, rate_pct: null as number | null };
    const n = v.rate === undefined ? null : parseRatePct(v.rate);
    if (n === null) {
      ctx.addIssue({ code: "custom", message: "invalid rate", path: ["rate"] });
      return z.NEVER;
    }
    return { ...v, rate_pct: n as number | null };
  });
export type RateInput = z.infer<typeof rateSchema>;

export const activatePlanSchema = z.object({
  plan_id: id,
  effective_from: day,
  assign_sales_reps: z.enum(["1", "0"]).default("1"),
});

export const deactivatePlanSchema = z.object({
  plan_id: id,
  effective_to: day,
  reason: z.string().min(3).max(500),
});

/** Field names of a failed parse (to pick the most helpful message). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
