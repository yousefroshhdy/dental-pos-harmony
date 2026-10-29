import { z } from "zod";
import { isValidPercent, isValidPrice, parseAttributes } from "./logic";

/**
 * Input validation for the catalogue Server Actions. These reject malformed input
 * early; the api.* commands validate everything again (and decide permissions).
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
/** A checkbox is present ("on") when ticked and absent otherwise. */
const checkbox = z.preprocess((v) => v === "on" || v === "true", z.boolean());
const date = z.iso.date();
const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/;
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}$/;

const code = z.string().regex(CODE_PATTERN).transform((s) => s.toUpperCase());
const sku = z.string().regex(SKU_PATTERN).transform((s) => s.toUpperCase());
const price = z.string().refine(isValidPrice);
const percent = z.string().refine(isValidPercent);

export const productSchema = z.object({
  product_id: id,
  brand_id: id,
  category_id: id,
  code,
  name_en: z.string().min(2).max(160),
  name_ar: z.string().max(160).optional(),
  description: z.string().max(2000).optional(),
  is_lot_tracked: checkbox,
  is_expiry_tracked: checkbox,
  is_serial_tracked: checkbox,
  /** Only on create; later changes go through the status buttons. */
  status: z.enum(["draft", "active"]).optional(),
  /** "create" redirects to the new product; "update" stays on the page. */
  mode: z.enum(["create", "update"]),
  locale,
});

export const productStatusSchema = z.object({
  product_id: id,
  status: z.enum(["draft", "active", "discontinued"]),
});

export const variantSchema = z.object({
  variant_id: id,
  product_id: id,
  sku,
  name_en: z.string().min(1).max(160),
  attributes: z
    .string()
    .max(6000)
    .optional()
    .transform((text, ctx) => {
      const parsed = parseAttributes(text ?? "");
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: `attributes line ${parsed.line}` });
        return z.NEVER;
      }
      return parsed.value;
    }),
  barcode: z.string().regex(/^[0-9A-Za-z-]{4,64}$/).optional(),
  uom: z
    .string()
    .optional()
    .transform((v) => (v ?? "unit").toLowerCase())
    .pipe(z.string().regex(/^[a-z][a-z_]{0,19}$/)),
  reorder_point: z.preprocess((v) => (v === undefined ? 0 : v), intIn(0, 1_000_000)),
});

export const variantStatusSchema = z.object({
  variant_id: id,
  status: z.enum(["active", "discontinued"]),
});

export const priceListSchema = z
  .object({
    price_list_id: id,
    code,
    name: z.string().min(2).max(120),
    kind: z.enum(["standard", "customer", "promotional"]),
    priority: intIn(1, 1000),
    valid_from: date,
    valid_to: date.optional(),
    is_active: checkbox,
    mode: z.enum(["create", "update"]),
    locale,
  })
  .refine((v) => !v.valid_to || v.valid_to >= v.valid_from, { path: ["valid_to"] });

export const priceItemSchema = z.object({
  price_list_id: id,
  /** Either the variant id (row edit) or a SKU typed in the add form. */
  variant_id: id.optional(),
  sku: sku.optional(),
  unit_price: price,
  min_qty: z.preprocess((v) => (v === undefined ? 1 : v), intIn(1, 100_000)),
}).refine((v) => v.variant_id || v.sku, { path: ["sku"] });

export const removePriceItemSchema = z.object({
  price_list_id: id,
  variant_id: id,
  min_qty: intIn(1, 100_000),
});

export const assignCustomerSchema = z
  .object({
    price_list_id: id,
    customer_no: z.string().min(1).max(40),
    valid_from: date,
    valid_to: date.optional(),
  })
  .refine((v) => !v.valid_to || v.valid_to >= v.valid_from, { path: ["valid_to"] });

export const endAssignmentSchema = z.object({
  price_list_id: id,
  customer_id: id,
  valid_from: date,
  end_on: date.optional(),
});

export const promotionSchema = z
  .object({
    promotion_id: id,
    name: z.string().min(2).max(120),
    discount_pct: percent,
    valid_from: date,
    valid_to: date.optional(),
    brand_id: id.optional(),
    category_id: id.optional(),
    sku: sku.optional(),
    customer_no: z.string().max(40).optional(),
    min_qty: z.preprocess((v) => (v === undefined ? 1 : v), intIn(1, 100_000)),
    priority: z.preprocess((v) => (v === undefined ? 100 : v), intIn(1, 1000)),
  })
  .refine((v) => !v.valid_to || v.valid_to >= v.valid_from, { path: ["valid_to"] });

export const endPromotionSchema = z.object({ promotion_id: id });

/** Field names that failed validation (first path segment), for aria-invalid hints. */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
