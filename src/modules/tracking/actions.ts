"use server";

import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { ackNoticeSchema, endShiftSchema, recordPingsSchema, startShiftSchema } from "./schemas";
import type { AckResult, DeviceResult, EndShiftResult, PingsResult, StartShiftResult, TrackingStatus } from "./types";

/**
 * Tracking device commands (D-14). Each validates its payload and calls exactly
 * one api.* command as the signed-in user. The payload is built on the device
 * before the first attempt (ids, fix, device time), so the offline queue can
 * replay it unchanged (offline.ts); every command is idempotent on its client
 * ref / point ids. The notice, the open shift, the shift window and all
 * permissions are decided by Postgres. No revalidation: the calling card shows
 * the answer, and the pages are dynamic.
 */

function failure<T>(error: AppError): DeviceResult<T> {
  return {
    ok: false,
    code: error.code,
    messageKey: error.messageKey,
    // Network loss or a rolled-back attempt: the same payload may be sent again.
    retryable: error.retryable || error.code === "UNAVAILABLE",
    requestId: error.requestId,
  };
}

const invalid = <T>(): DeviceResult<T> => ({ ok: false, code: "VALIDATION", messageKey: "VALIDATION", retryable: false });

export async function acknowledgeTrackingNotice(payload: unknown): Promise<DeviceResult<AckResult>> {
  const parsed = ackNoticeSchema.safeParse(payload);
  if (!parsed.success) return invalid();
  const result = await callCommand<AckResult>("acknowledge_tracking_notice", { p_version: parsed.data.version });
  return result.ok ? { ok: true, data: result.data } : failure(result.error);
}

export async function startShift(payload: unknown): Promise<DeviceResult<StartShiftResult>> {
  const parsed = startShiftSchema.safeParse(payload);
  if (!parsed.success) return invalid();
  const p = parsed.data;
  const result = await callCommand<StartShiftResult>("start_shift", {
    p_client_ref: p.client_ref,
    p_lat: p.lat,
    p_lng: p.lng,
    p_accuracy_m: p.accuracy_m,
    p_captured_at: p.captured_at,
  });
  return result.ok ? { ok: true, data: result.data } : failure(result.error);
}

export async function endShift(payload: unknown): Promise<DeviceResult<EndShiftResult>> {
  const parsed = endShiftSchema.safeParse(payload);
  if (!parsed.success) return invalid();
  const p = parsed.data;
  const result = await callCommand<EndShiftResult>("end_shift", {
    p_client_ref: p.client_ref,
    p_lat: p.lat,
    p_lng: p.lng,
    p_accuracy_m: p.accuracy_m,
    p_captured_at: p.captured_at,
    p_shift_ref: p.shift_ref,
  });
  return result.ok ? { ok: true, data: result.data } : failure(result.error);
}

export async function recordLocationPings(payload: unknown): Promise<DeviceResult<PingsResult>> {
  const parsed = recordPingsSchema.safeParse(payload);
  if (!parsed.success) return invalid();
  const result = await callCommand<PingsResult>("record_location_pings", { p_pings: parsed.data.pings });
  return result.ok ? { ok: true, data: result.data } : failure(result.error);
}

/** The caller's own tracking status, for the client collector to re-check the server. */
export async function loadTrackingStatus(): Promise<DeviceResult<TrackingStatus>> {
  const result = await callCommand<TrackingStatus>("my_tracking_status");
  return result.ok ? { ok: true, data: result.data } : failure(result.error);
}
