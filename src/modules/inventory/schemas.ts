import { z } from "zod";
import { parseStockLineValue, REASON_CODES } from "./logic";

/**
 * Input validation for the inventory Server Actions. These reject malformed
 * input early; permissions, warehouse scope, stock sufficiency, lot/expiry rules
 * and approval limits are enforced again by the api.* commands in Postgres.
 * Nothing here carries a price, total or user id: the database derives them.
 */

/** FormData → plain object of single values: strings trimmed, empty strings and files dropped. */
export function formToObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

/**
 * Repeated line fields (`<input name="lot_no">` once per line) → one object per
 * line, by position. Lines whose fields are all blank are dropped, so empty
 * rows left in the form are ignored.
 */
export function formLines(form: FormData, fields: readonly string[]): Record<string, string>[] {
  const columns = fields.map((f) => form.getAll(f).map((v) => (typeof v === "string" ? v.trim() : "")));
  const count = Math.max(0, ...columns.map((c) => c.length));
  const lines: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const line: Record<string, string> = {};
    fields.forEach((f, j) => {
      const v = columns[j]?.[i];
      if (v) line[f] = v;
    });
    if (Object.keys(line).length > 0) lines.push(line);
  }
  return lines;
}

// Accepts any 8-4-4-4-12 hex id (seeded fixtures are not always RFC-4122 v4).
const id = z.guid();
const locale = z.enum(["ar", "en"]);
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s));
const wholeQty = z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(1).max(1_000_000));

export const MAX_LINES = 50;

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export const RECEIPT_LINE_FIELDS = ["variant_id", "lot_no", "expiry_date", "quantity", "unit_cost"] as const;

export const receiptLineSchema = z.object({
  variant_id: id,
  /** "NO-LOT" for products that are not lot-tracked (ADR-013). */
  lot_no: z.string().trim().min(1).max(60),
  expiry_date: isoDate.optional(),
  quantity: wholeQty,
  /** Purchase cost from the supplier document (EGP). Blank = current catalogue cost. */
  unit_cost: z.preprocess(
    (v) => (v === undefined ? undefined : Number(v)),
    z.number().nonnegative().max(999_999_999_999.99).optional(),
  ),
});
export type ReceiptLineInput = z.infer<typeof receiptLineSchema>;

export const createReceiptSchema = z.object({
  warehouse_id: id,
  supplier: z.string().trim().min(2).max(200),
  shipment_ref: z.string().trim().max(100).optional(),
  locale,
  lines: z.array(receiptLineSchema).min(1).max(MAX_LINES),
});

/** p_items for api.create_goods_receipt: only the five allowed keys, numbers as JSON numbers. */
export function toReceiptItems(lines: ReceiptLineInput[]) {
  return lines.map((l) => ({
    variant_id: l.variant_id,
    lot_no: l.lot_no,
    ...(l.expiry_date ? { expiry_date: l.expiry_date } : {}),
    quantity: l.quantity,
    ...(l.unit_cost !== undefined ? { unit_cost: Math.round(l.unit_cost * 100) / 100 } : {}),
  }));
}

export const receiptIdSchema = z.object({ receipt_id: id });

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const TRANSFER_LINE_FIELDS = ["line", "quantity"] as const;

const stockLine = z.string().transform((v, ctx) => {
  const parsed = parseStockLineValue(v);
  if (!parsed) {
    ctx.addIssue({ code: "custom", message: "invalid stock line" });
    return z.NEVER;
  }
  return parsed;
});

export const transferLineSchema = z.object({ line: stockLine, quantity: wholeQty });

export const createTransferSchema = z
  .object({
    from_warehouse_id: id,
    to_warehouse_id: id,
    locale,
    lines: z.array(transferLineSchema).min(1).max(MAX_LINES),
  })
  .refine((v) => v.from_warehouse_id !== v.to_warehouse_id, { path: ["to_warehouse_id"], message: "same warehouse" });

export function toTransferItems(lines: z.infer<typeof transferLineSchema>[]) {
  return lines.map((l) => ({ variant_id: l.line.variantId, lot_id: l.line.lotId, quantity: l.quantity }));
}

export const transferIdSchema = z.object({ transfer_id: id });

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export const adjustmentSchema = z
  .object({
    warehouse_id: id,
    line: stockLine,
    direction: z.enum(["in", "out"]),
    quantity: wholeQty,
    reason_code: z.enum(REASON_CODES),
    note: z.string().trim().max(300).optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/),
  })
  .refine((v) => v.reason_code !== "other" || (v.note?.length ?? 0) >= 3, { path: ["note"], message: "note required" });

/** Which inventory.errors / errors key a validation failure maps to. */
export function validationCode(error: z.ZodError): string {
  const fields = new Set(error.issues.map((i) => String(i.path[0] ?? "")));
  if (fields.has("lines") && error.issues.some((i) => i.path[0] === "lines" && i.path.length === 1)) return "NO_LINES";
  if (fields.has("to_warehouse_id") && error.issues.some((i) => i.message === "same warehouse")) return "SAME_WAREHOUSE";
  if (fields.has("note")) return "REASON_REQUIRED";
  return "VALIDATION";
}
