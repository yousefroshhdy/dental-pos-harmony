import { GPS_CONSENT_VERSION } from "./consent";
import type { GeoOutcome } from "./geo";
import type { CheckInPayload, CheckOutPayload } from "./schemas";
import type { VisitOutcome } from "./types";

/**
 * Builders for device-command payloads (pure). A payload is built ONCE, before
 * the first attempt, and every retry or queued replay sends it unchanged.
 */

/** The fix part of a payload: a fix, or nulls when there is none (→ no_device_location). */
function fixFields(geo: GeoOutcome | null) {
  return geo?.ok ? { lat: geo.lat, lng: geo.lng, accuracy_m: geo.accuracyM } : { lat: null, lng: null, accuracy_m: null };
}

/** Device time: the fix's own timestamp when there is one, else the device clock now. */
function capturedAt(geo: GeoOutcome | null, now: Date | undefined): string {
  return geo?.ok ? geo.capturedAt : (now ?? new Date()).toISOString();
}

/**
 * Check-in payload. `visitId` is the planned visit's id, or a fresh
 * crypto.randomUUID() for an unplanned visit. `geo` null = the rep chose to
 * check in without location.
 */
export function buildCheckInPayload(input: {
  visitId: string;
  customerId: string;
  geo: GeoOutcome | null;
  consented: boolean;
  now?: Date;
}): CheckInPayload {
  const { geo } = input;
  const geoError = geo === null ? ("skipped" as const) : geo.ok ? undefined : geo.reason;
  return {
    visit_id: input.visitId,
    customer_id: input.customerId,
    ...fixFields(geo),
    captured_at: capturedAt(geo, input.now),
    device: {
      platform: "web",
      ...(geoError ? { geo_error: geoError } : {}),
      ...(input.consented ? { consent_version: GPS_CONSENT_VERSION } : {}),
    },
  };
}

export function buildCheckOutPayload(input: {
  visitId: string;
  outcome: VisitOutcome;
  notes: string;
  /** ISO instant, already converted from the Cairo wall-clock input. */
  nextFollowUpAt: string | null;
  geo: GeoOutcome | null;
  now?: Date;
}): CheckOutPayload {
  const notes = input.notes.trim();
  return {
    visit_id: input.visitId,
    outcome: input.outcome,
    notes: notes === "" ? null : notes,
    ...fixFields(input.geo),
    captured_at: capturedAt(input.geo, input.now),
    next_follow_up_at: input.nextFollowUpAt,
  };
}
