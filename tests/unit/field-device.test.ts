import { describe, expect, it } from "vitest";
import {
  GPS_CONSENT_STORAGE_KEY,
  GPS_CONSENT_VERSION,
  hasCurrentConsent,
  parseConsent,
  recordConsent,
  withdrawConsent,
  type ConsentStorage,
} from "@/modules/field/consent";
import { captureFix, GEO_OPTIONS, reasonOf, roundFix, type GeoEnv } from "@/modules/field/geo";
import { buildCheckInPayload, buildCheckOutPayload } from "@/modules/field/payloads";
import { checkInSchema, checkOutSchema, completeTaskSchema, createTaskSchema, visitExceptionSchema } from "@/modules/field/schemas";

const VISIT = "55555555-5555-4555-8555-555555555555";
const CUSTOMER = "66666666-6666-4666-8666-666666666666";
const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-29T09:00:00.000Z");

function memoryStorage(): ConsentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function geoEnv(result: { coords?: Partial<GeolocationCoordinates>; timestamp?: number; error?: number }): GeoEnv & { options?: PositionOptions } {
  const env: GeoEnv & { options?: PositionOptions } = {
    isSecureContext: true,
    geolocation: {
      getCurrentPosition(success, failure, options) {
        env.options = options;
        if (result.error !== undefined) failure?.({ code: result.error, message: "x" } as GeolocationPositionError);
        else success({ coords: result.coords, timestamp: result.timestamp ?? NOW.getTime() } as GeolocationPosition);
      },
    },
  };
  return env;
}

describe("GPS capture", () => {
  it("asks for one fresh high-accuracy fix with a timeout", async () => {
    const env = geoEnv({ coords: { latitude: 30.0444196, longitude: 31.2357116, accuracy: 12.345 } });
    const fix = await captureFix(env);
    expect(env.options).toEqual(GEO_OPTIONS);
    expect(GEO_OPTIONS).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    expect(GEO_OPTIONS.timeout).toBeGreaterThan(0);
    expect(fix).toEqual({ ok: true, lat: 30.04442, lng: 31.235712, accuracyM: 12.3, capturedAt: NOW.toISOString() });
  });

  it("maps browser errors, including permission denied", async () => {
    expect(await captureFix(geoEnv({ error: 1 }))).toEqual({ ok: false, reason: "denied" });
    expect(await captureFix(geoEnv({ error: 2 }))).toEqual({ ok: false, reason: "unavailable" });
    expect(await captureFix(geoEnv({ error: 3 }))).toEqual({ ok: false, reason: "timeout" });
    expect(await captureFix({})).toEqual({ ok: false, reason: "unsupported" });
    expect(await captureFix({ ...geoEnv({ error: 1 }), isSecureContext: false })).toEqual({ ok: false, reason: "insecure" });
    expect(reasonOf(99)).toBe("unavailable");
  });

  it("treats a fix with missing numbers as unavailable", async () => {
    expect(await captureFix(geoEnv({ coords: { latitude: Number.NaN, longitude: 31, accuracy: 5 } }))).toEqual({ ok: false, reason: "unavailable" });
  });

  it("rounds to the column precision", () => {
    expect(roundFix(30.12345678, -31.98765432, 7.06)).toEqual({ lat: 30.123457, lng: -31.987654, accuracyM: 7.1 });
  });
});

describe("device payloads", () => {
  const fix = { ok: true as const, lat: 30.04442, lng: 31.235712, accuracyM: 12.3, capturedAt: "2026-10-29T08:59:58.000Z" };

  it("sends the fix's own device timestamp and accuracy", () => {
    const p = buildCheckInPayload({ visitId: VISIT, customerId: CUSTOMER, geo: fix, consented: true, now: NOW });
    expect(p).toEqual({
      visit_id: VISIT,
      customer_id: CUSTOMER,
      lat: 30.04442,
      lng: 31.235712,
      accuracy_m: 12.3,
      captured_at: "2026-10-29T08:59:58.000Z",
      device: { platform: "web", consent_version: GPS_CONSENT_VERSION },
    });
    expect(checkInSchema.safeParse(p).success).toBe(true);
  });

  it("checks in without location as nulls plus the reason (→ no_device_location)", () => {
    const denied = buildCheckInPayload({ visitId: VISIT, customerId: CUSTOMER, geo: { ok: false, reason: "denied" }, consented: true, now: NOW });
    expect(denied).toMatchObject({ lat: null, lng: null, accuracy_m: null, captured_at: NOW.toISOString() });
    expect(denied.device).toEqual({ platform: "web", geo_error: "denied", consent_version: GPS_CONSENT_VERSION });
    const skipped = buildCheckInPayload({ visitId: VISIT, customerId: CUSTOMER, geo: null, consented: false, now: NOW });
    expect(skipped.device).toEqual({ platform: "web", geo_error: "skipped" });
    expect(checkInSchema.safeParse(denied).success).toBe(true);
    expect(checkInSchema.safeParse(skipped).success).toBe(true);
  });

  it("is deterministic, so a retry replays the same payload", () => {
    const a = buildCheckInPayload({ visitId: VISIT, customerId: CUSTOMER, geo: fix, consented: true, now: NOW });
    const b = buildCheckInPayload({ visitId: VISIT, customerId: CUSTOMER, geo: fix, consented: true, now: new Date() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("builds a check-out payload", () => {
    const p = buildCheckOutPayload({
      visitId: VISIT,
      outcome: "follow_up",
      notes: "  ",
      nextFollowUpAt: "2026-10-30T08:00:00.000Z",
      geo: null,
      now: NOW,
    });
    expect(p).toEqual({
      visit_id: VISIT,
      outcome: "follow_up",
      notes: null,
      lat: null,
      lng: null,
      accuracy_m: null,
      captured_at: NOW.toISOString(),
      next_follow_up_at: "2026-10-30T08:00:00.000Z",
    });
    expect(checkOutSchema.safeParse(p).success).toBe(true);
  });
});

describe("schemas", () => {
  const base = buildCheckInPayload({
    visitId: VISIT,
    customerId: CUSTOMER,
    geo: { ok: true, lat: 30, lng: 31, accuracyM: 10, capturedAt: NOW.toISOString() },
    consented: true,
  });

  it("rejects a partial fix, out-of-range coordinates and bad timestamps", () => {
    expect(checkInSchema.safeParse({ ...base, accuracy_m: null }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, lat: 91 }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, lng: -181 }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, accuracy_m: -1 }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, captured_at: "yesterday" }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, visit_id: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts only non-identifying device facts and no extra fields", () => {
    expect(checkInSchema.safeParse({ ...base, device: { platform: "web", user_agent: "x" } }).success).toBe(false);
    expect(checkInSchema.safeParse({ ...base, employee_id: VISIT }).success).toBe(false);
  });

  it("rejects a follow-up before the visit and an unknown outcome", () => {
    const out = buildCheckOutPayload({ visitId: VISIT, outcome: "demo", notes: "", nextFollowUpAt: null, geo: null, now: NOW });
    expect(checkOutSchema.safeParse({ ...out, next_follow_up_at: "2026-10-29T08:00:00.000Z" }).success).toBe(false);
    expect(checkOutSchema.safeParse({ ...out, outcome: "bribe" }).success).toBe(false);
    expect(checkOutSchema.safeParse(out).success).toBe(true);
  });

  it("needs a reason for an exception", () => {
    expect(visitExceptionSchema.safeParse({ visit_id: VISIT, reason: "  " }).success).toBe(false);
    expect(visitExceptionSchema.safeParse({ visit_id: VISIT, reason: "Clinic moved next door" }).success).toBe(true);
  });

  it("converts a task due time from Cairo wall clock", () => {
    const parsed = createTaskSchema.parse({ title: "Send price list", due_local: "2026-01-15T10:00" });
    expect(parsed).toEqual({ title: "Send price list", due_local: "2026-01-15T08:00:00.000Z", kind: "follow_up" });
    expect(createTaskSchema.safeParse({ title: "x", due_local: "2026-01-15T10:00" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Send", due_local: "soon" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Send", due_local: "2026-01-15T10:00", kind: "party" }).success).toBe(false);
    expect(completeTaskSchema.safeParse({ task_id: VISIT, outcome: "" }).success).toBe(false);
  });
});

describe("GPS consent (device-only, interim)", () => {
  it("records, checks and withdraws the current version per user", () => {
    const store = memoryStorage();
    expect(hasCurrentConsent(USER, store)).toBe(false);
    const record = recordConsent(USER, NOW, store);
    expect(record).toEqual({ version: GPS_CONSENT_VERSION, acceptedAt: NOW.toISOString(), userId: USER });
    expect(hasCurrentConsent(USER, store)).toBe(true);
    expect(hasCurrentConsent("22222222-2222-4222-8222-222222222222", store)).toBe(false);
    withdrawConsent(store);
    expect(hasCurrentConsent(USER, store)).toBe(false);
  });

  it("asks again when the text version changes or the record is corrupt", () => {
    const store = memoryStorage();
    store.setItem(GPS_CONSENT_STORAGE_KEY, JSON.stringify({ version: "old", acceptedAt: NOW.toISOString(), userId: USER }));
    expect(hasCurrentConsent(USER, store)).toBe(false);
    store.setItem(GPS_CONSENT_STORAGE_KEY, "{not json");
    expect(hasCurrentConsent(USER, store)).toBe(false);
    expect(parseConsent(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it("works when storage is unavailable", () => {
    expect(hasCurrentConsent(USER, null)).toBe(false);
    expect(recordConsent(USER, NOW, null).userId).toBe(USER);
  });
});
