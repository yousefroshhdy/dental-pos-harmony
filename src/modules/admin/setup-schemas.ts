import { z } from "zod";

/** Egypt bounding box: the same as the database checks and src/lib/maps/geocode.ts. */
const EGYPT_BOUNDS_PLAIN = { minLat: 21.5, maxLat: 32.0, minLng: 24.5, maxLng: 37.5 } as const;

/**
 * Input validation for the setup Server Actions. Early rejection only: every rule is checked
 * again by the api.* command (api.create_warehouse, api.set_employee_base_location,
 * api.authorize_sign_in_link, api.register_user, api.grant_role, ...).
 */
const id = z.guid();
const locale = z.enum(["ar", "en"]);

/** Optional number from a form field ("" → undefined; Arabic digits and the Arabic comma accepted). */
const optionalNumber = (min: number, max: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === "") return undefined;
    const s = String(v)
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/[٫،]/g, ".")
      .trim();
    return s === "" ? undefined : Number(s);
  }, z.number().min(min).max(max).optional());

export const createWarehouseSchema = z.object({
  /** Generated when the page renders: a resubmitted form is a replay, not a second warehouse. */
  warehouse_id: id,
  code: z
    .string()
    .transform((c) => c.trim().toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._-]{1,39}$/)),
  name: z.string().min(2).max(120),
});

export const baseLocationSchema = z
  .object({
    employee_id: id,
    intent: z.enum(["save", "clear"]).default("save"),
    address: z.string().min(3).max(300).optional(),
    lat: optionalNumber(EGYPT_BOUNDS_PLAIN.minLat, EGYPT_BOUNDS_PLAIN.maxLat),
    lng: optionalNumber(EGYPT_BOUNDS_PLAIN.minLng, EGYPT_BOUNDS_PLAIN.maxLng),
    lead_radius_km: optionalNumber(0.5, 50),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { path: ["lat"], message: "latitude and longitude go together" })
  .refine((v) => v.intent === "clear" || v.address !== undefined || v.lat !== undefined, {
    path: ["address"],
    message: "an address or a point is needed",
  });

export const issueLoginSchema = z.object({
  employee_id: id,
  role_id: id.optional(),
  territory_id: id.optional(),
  /** The invitee's language (core.user_profiles.locale and the link's page). */
  locale,
});
