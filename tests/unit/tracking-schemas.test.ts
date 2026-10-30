import { describe, expect, it } from "vitest";
import { ackNoticeSchema, dayParamsSchema, endShiftSchema, recordPingsSchema, startShiftSchema } from "@/modules/tracking/schemas";

// Synthetic ids only (D-03).
const REF = "00000000-0000-4000-8000-0000000008a1";
const at = "2026-10-30T07:00:00.000Z";

describe("tracking payloads", () => {
  it("a start is a ref, a whole fix or none, and a device time", () => {
    expect(startShiftSchema.safeParse({ client_ref: REF, lat: 30.04, lng: 31.23, accuracy_m: 12, captured_at: at }).success).toBe(true);
    expect(startShiftSchema.safeParse({ client_ref: REF, lat: null, lng: null, accuracy_m: null, captured_at: at }).success).toBe(true);
    expect(startShiftSchema.safeParse({ client_ref: REF, lat: 30.04, lng: null, accuracy_m: 12, captured_at: at }).success).toBe(false);
    expect(startShiftSchema.safeParse({ client_ref: REF, lat: null, lng: null, accuracy_m: 5, captured_at: at }).success).toBe(false);
    expect(startShiftSchema.safeParse({ client_ref: "nope", lat: null, lng: null, accuracy_m: null, captured_at: at }).success).toBe(false);
    expect(startShiftSchema.safeParse({ client_ref: REF, lat: 95, lng: 31, accuracy_m: 1, captured_at: at }).success).toBe(false);
  });
  it("an end may name the shift it ends", () => {
    expect(endShiftSchema.safeParse({ client_ref: REF, shift_ref: REF, lat: null, lng: null, accuracy_m: null, captured_at: at }).success).toBe(true);
    expect(endShiftSchema.safeParse({ client_ref: REF, shift_ref: null, lat: null, lng: null, accuracy_m: null, captured_at: "yesterday" }).success).toBe(false);
  });
  it("points: 1 to 500, each with an id, a position, a device time and source pwa", () => {
    const ping = { id: REF, lat: 30.04, lng: 31.23, accuracy_m: null, captured_at: at, source: "pwa" };
    expect(recordPingsSchema.safeParse({ pings: [ping] }).success).toBe(true);
    expect(recordPingsSchema.safeParse({ pings: [] }).success).toBe(false);
    expect(recordPingsSchema.safeParse({ pings: Array.from({ length: 501 }, () => ping) }).success).toBe(false);
    expect(recordPingsSchema.safeParse({ pings: [{ ...ping, source: "native" }] }).success).toBe(false);
    expect(recordPingsSchema.safeParse({ pings: [{ ...ping, extra: 1 }] }).success).toBe(false);
  });
  it("notice versions and route params", () => {
    expect(ackNoticeSchema.safeParse({ version: "2026-10-30.1" }).success).toBe(true);
    expect(ackNoticeSchema.safeParse({ version: "x; drop" }).success).toBe(false);
    expect(dayParamsSchema.safeParse({ employeeId: REF, date: "2026-10-30" }).success).toBe(true);
    expect(dayParamsSchema.safeParse({ employeeId: REF, date: "2026-13-01" }).success).toBe(false);
  });
});
