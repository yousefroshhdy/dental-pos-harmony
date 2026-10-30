import { z } from "zod";

/**
 * Input validation for the tracking Server Actions. It only rejects malformed
 * input early: the notice, the open shift, the shift window, the anomaly flags
 * and every permission are decided by the api.* commands in Postgres.
 */

// Any 8-4-4-4-12 hex id (seeded fixtures are not always RFC 9562 v4).
const id = z.guid();
const isoInstant = z.iso.datetime({ offset: true });

/** A fix is lat + lng (+ accuracy), or none at all (the start/end is then flagged on the server). */
const fix = {
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
  accuracy_m: z.number().min(0).max(9_999_999.9).nullable(),
};
const fixComplete = (v: { lat: number | null; lng: number | null; accuracy_m: number | null }) =>
  (v.lat === null) === (v.lng === null) && (v.lat !== null || v.accuracy_m === null);

export const ackNoticeSchema = z.object({ version: z.string().regex(/^[0-9A-Za-z._-]{1,40}$/) }).strict();

export const startShiftSchema = z
  .object({ client_ref: id, ...fix, captured_at: isoInstant })
  .strict()
  .refine(fixComplete, { message: "lat, lng and accuracy_m go together", path: ["lat"] });
export type StartShiftPayload = z.infer<typeof startShiftSchema>;

export const endShiftSchema = z
  .object({ client_ref: id, shift_ref: id.nullable(), ...fix, captured_at: isoInstant })
  .strict()
  .refine(fixComplete, { message: "lat, lng and accuracy_m go together", path: ["lat"] });
export type EndShiftPayload = z.infer<typeof endShiftSchema>;

export const MAX_PINGS_PER_UPLOAD = 500;

export const pingSchema = z
  .object({
    id,
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0).max(9_999_999.9).nullable(),
    captured_at: isoInstant,
    source: z.literal("pwa"),
  })
  .strict();

export const recordPingsSchema = z.object({ pings: z.array(pingSchema).min(1).max(MAX_PINGS_PER_UPLOAD) }).strict();
export type RecordPingsPayload = z.infer<typeof recordPingsSchema>;

/** /tracking/[employeeId]/[date] route params. */
export const dayParamsSchema = z.object({
  employeeId: id,
  date: z.iso.date(),
});
