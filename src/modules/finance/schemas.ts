import { z } from "zod";
import { MAX_AMOUNT, parseAmount, parseIsoDate } from "./logic";
import { COLLECTION_ACTIONS, RECORDABLE_METHODS } from "./types";

/**
 * Input validation for the finance Server Actions. These only reject malformed
 * input early; permission, scope, status and every amount the business depends
 * on are decided again by the api.* command in Postgres. The client never sends
 * a price, discount, tax or total — only ids, quantities, the amount of money
 * physically received, a goodwill credit amount, or an allocation split.
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
/** Generated on the device once per attempt; a retry with the same key is a replay. */
const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9-]+$/);

const amountText = z
  .string()
  .transform((raw, ctx) => {
    const value = parseAmount(raw);
    if (value === null) {
      ctx.addIssue({ code: "custom", message: "invalid amount" });
      return z.NEVER;
    }
    return value;
  });

const isoDate = z.string().refine((v) => parseIsoDate(v) !== null, "invalid date");

function json<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
}

export const issueInvoiceSchema = z.object({ order_id: id, idempotency_key: idempotencyKey, locale });

/** One credit line: an invoice line and a whole quantity — never an amount. */
export const creditLineSchema = z.strictObject({ invoice_item_id: id, quantity: z.number().int().min(1).max(1_000_000) });

export const creditNoteSchema = z
  .object({
    invoice_id: id,
    mode: z.enum(["lines", "amount"]),
    lines: json(z.array(creditLineSchema).min(1).max(500)).optional(),
    amount: amountText.optional(),
    reason,
    idempotency_key: idempotencyKey,
    locale,
  })
  .superRefine((v, ctx) => {
    if (v.mode === "lines" && !v.lines) ctx.addIssue({ code: "custom", path: ["lines"], message: "lines required" });
    if (v.mode === "amount" && v.amount === undefined) ctx.addIssue({ code: "custom", path: ["amount"], message: "amount required" });
  });
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

export const recordPaymentSchema = z
  .object({
    customer_id: id,
    amount: amountText,
    method: z.enum(RECORDABLE_METHODS),
    reference: z.string().max(100).optional(),
    cheque_due_date: isoDate.optional(),
    /** ISO timestamp computed on the device from its local date-time input. */
    received_at: z.iso.datetime({ offset: true }).optional(),
    client_ref: id,
    locale,
  })
  .superRefine((v, ctx) => {
    if (v.method === "cheque") {
      if (!v.cheque_due_date) ctx.addIssue({ code: "custom", path: ["cheque_due_date"], message: "cheque due date required" });
      if (!v.reference) ctx.addIssue({ code: "custom", path: ["reference"], message: "cheque number required" });
    } else if (v.cheque_due_date) {
      ctx.addIssue({ code: "custom", path: ["cheque_due_date"], message: "only cheques have a due date" });
    }
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const paymentRefSchema = z.object({ payment_id: id, locale });
export const paymentReasonSchema = paymentRefSchema.extend({ reason });
export const reversePaymentSchema = paymentReasonSchema.extend({ bounced: z.enum(["on", "true"]).optional() });

/** One allocation: an invoice and the part of the payment applied to it. */
export const allocationLineSchema = z.strictObject({
  invoice_id: id,
  amount: z
    .number()
    .positive()
    .max(MAX_AMOUNT)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "max 2 decimals"),
});

export const allocateSchema = z
  .object({
    payment_id: id,
    mode: z.enum(["fifo", "manual"]),
    allocations: json(z.array(allocationLineSchema).min(1).max(200)).optional(),
    idempotency_key: idempotencyKey,
    locale,
  })
  .superRefine((v, ctx) => {
    if (v.mode === "manual" && !v.allocations) ctx.addIssue({ code: "custom", path: ["allocations"], message: "allocations required" });
  });

export const reverseAllocationSchema = z.object({ allocation_id: id, payment_id: id, reason, locale });

export const collectionUpdateSchema = z
  .object({
    task_id: id,
    action: z.enum(COLLECTION_ACTIONS),
    promised_date: isoDate.optional(),
    promised_amount: amountText.optional(),
    note: z.string().max(1000).optional(),
    locale,
  })
  .superRefine((v, ctx) => {
    if (v.action === "promise" && !v.promised_date) ctx.addIssue({ code: "custom", path: ["promised_date"], message: "date required" });
    if ((v.action === "close" || v.action === "escalate") && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "note required" });
  });
export type CollectionUpdateInput = z.infer<typeof collectionUpdateSchema>;

/** Field names that failed validation (first path segment). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
