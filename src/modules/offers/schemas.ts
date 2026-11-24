import { z } from "zod";

/**
 * Input validation for the offer Server Actions. It only rejects malformed input
 * early: api.upsert_offer re-checks everything (permission, codes, prices, items,
 * window, targets) in Postgres.
 */
const id = z.guid();
const twoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const amount = z.number().gt(0).max(999_999_999_999.99).refine(twoDecimals);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const offerItemSchema = z.strictObject({
  variant_id: id,
  quantity: z.number().int().min(1).max(100_000),
  is_bonus: z.literal(true).optional(),
  net_unit_price: amount.optional(),
});

export const offerInputSchema = z.strictObject({
  offer_id: id,
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,39}$/),
  name_en: z.string().trim().min(2).max(160),
  name_ar: z.string().trim().max(160).nullable(),
  description: z.string().trim().max(2000).nullable(),
  pricing_mode: z.enum(["package", "per_line"]),
  package_price: amount.nullable(),
  valid_from: isoDate,
  valid_to: isoDate.nullable(),
  items: z.array(offerItemSchema).min(1).max(50),
  customer_nos: z.array(z.string().trim().min(1).max(40)).max(500),
  target_tags: z.array(z.string().trim().min(1).max(60)).max(20),
  expected_version: z.number().int().min(1).nullable(),
});
export type OfferInput = z.infer<typeof offerInputSchema>;

export const offerActiveSchema = z.object({ offer_id: id, active: z.enum(["true", "false"]) });
