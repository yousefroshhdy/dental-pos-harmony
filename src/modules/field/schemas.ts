import { z } from "zod";
import { zonedLocalToInstant } from "./logic";
import { TASK_KINDS, VISIT_OUTCOMES } from "./types";

/**
 * Input validation for the field Server Actions. These only reject malformed
 * input early; permissions, scope, state and the geofence verdict are decided
 * by the api.* command in Postgres.
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
const isoInstant = z.iso.datetime({ offset: true });

export const GEO_ERRORS = ["denied", "unavailable", "timeout", "unsupported", "insecure", "skipped"] as const;

/**
 * A fix is all three of lat/lng/accuracy, or none (→ no_device_location).
 * Accuracy is required with a fix: without it the server cannot judge the verdict.
 */
const fix = {
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).max(9_999_999.9).nullable(),
};
const fixComplete = (v: { lat: number | null; lng: number | null; accuracy_m: number | null }) =>
  (v.lat === null) === (v.lng === null) && (v.lat === null) === (v.accuracy_m === null);

/** Only non-identifying device facts (PDPL minimisation, D-03). */
export const deviceInfoSchema = z
  .object({
    platform: z.literal("web"),
    geo_error: z.enum(GEO_ERRORS).optional(),
    consent_version: z.string().max(40).optional(),
  })
  .strict();

export const checkInSchema = z
  .object({
    visit_id: id,
    customer_id: id,
    ...fix,
    captured_at: isoInstant,
    device: deviceInfoSchema,
  })
  .strict()
  .refine(fixComplete, { message: "lat, lng and accuracy_m go together", path: ["lat"] });
export type CheckInPayload = z.infer<typeof checkInSchema>;

export const checkOutSchema = z
  .object({
    visit_id: id,
    outcome: z.enum(VISIT_OUTCOMES),
    notes: z.string().trim().max(2000).nullable(),
    ...fix,
    captured_at: isoInstant,
    next_follow_up_at: isoInstant.nullable(),
  })
  .strict()
  .refine(fixComplete, { message: "lat, lng and accuracy_m go together", path: ["lat"] })
  .refine((v) => v.next_follow_up_at === null || Date.parse(v.next_follow_up_at) > Date.parse(v.captured_at), {
    message: "next follow-up must be after the visit",
    path: ["next_follow_up_at"],
  });
export type CheckOutPayload = z.infer<typeof checkOutSchema>;

export const visitExceptionSchema = z
  .object({
    visit_id: id,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type VisitExceptionPayload = z.infer<typeof visitExceptionSchema>;

/** A Cairo wall-clock "YYYY-MM-DDTHH:mm" from <input type="datetime-local"> → ISO instant. */
const cairoLocal = z.string().transform((v, ctx) => {
  const instant = zonedLocalToInstant(v);
  if (!instant) {
    ctx.addIssue({ code: "custom", message: "invalid date and time" });
    return z.NEVER;
  }
  return instant.toISOString();
});

export const createTaskSchema = z.object({
  title: z.string().min(2).max(200),
  due_local: cairoLocal,
  kind: z.enum(TASK_KINDS).default("follow_up"),
  customer_id: id.optional(),
  /** Idempotency key generated on the device (api.create_task p_client_ref). */
  client_ref: id.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const completeTaskSchema = z.object({
  task_id: id,
  outcome: z.string().min(2).max(1000),
});

/** Field names that failed validation (first path segment). */
export function invalidFieldsOf(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean))];
}
