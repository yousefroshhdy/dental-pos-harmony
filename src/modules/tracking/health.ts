import type { CollectorProblem } from "./device-store";
import { localizedName } from "@/modules/field/logic";
import type { HealthRow, PingSource } from "./types";

/**
 * The tracking health panel (Phase P step 5): pure rules for the managers' panel
 * and for what the device reports about itself (api.report_device_status). The
 * database applies the same attention rule in api.v_tracking_health; the panel
 * re-derives it from the row with the server's clock (`checked_at`), so both agree.
 */

/** An open shift with no point arriving for longer than this needs attention. */
export const ATTENTION_AFTER_MS = 15 * 60_000;

/** The device sends its status at shift start and then every 5 minutes while collecting. */
export const STATUS_REPORT_INTERVAL_MS = 5 * 60_000;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

/**
 * True when the shift is open and nothing arrived for more than 15 minutes: since the
 * last point that reached the server, or since the shift started when none did yet.
 * Exactly 15 minutes is not yet attention. A closed shift never needs attention.
 */
export function needsAttention(
  row: Pick<HealthRow, "shift_open" | "shift_started_at" | "shift_last_received_at">,
  nowMs: number,
  thresholdMs: number = ATTENTION_AFTER_MS,
): boolean {
  if (!row.shift_open) return false;
  const since = ms(row.shift_last_received_at) ?? ms(row.shift_started_at);
  if (since === null || !Number.isFinite(nowMs)) return false;
  return nowMs - since > thresholdMs;
}

/** Whole minutes from `iso` to now (never negative); null without a time. */
export function ageMinutes(iso: string | null | undefined, nowMs: number): number | null {
  const at = ms(iso);
  if (at === null || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 60_000));
}

/** The panel's "now": the server clock of the read (falls back to this machine's clock). */
export function healthNow(rows: readonly Pick<HealthRow, "checked_at">[], fallback: () => number = Date.now): number {
  for (const r of rows) {
    const v = ms(r.checked_at);
    if (v !== null) return v;
  }
  return fallback();
}

export type ShiftState = "open" | "closed" | "never";

export function shiftState(row: Pick<HealthRow, "shift_id" | "shift_open">): ShiftState {
  if (!row.shift_id) return "never";
  return row.shift_open ? "open" : "closed";
}

/** Attention first, then open shifts, then by name (the caller's language). */
export function sortHealthRows(rows: readonly HealthRow[], locale: string, nowMs: number): HealthRow[] {
  const rank = (r: HealthRow) => (needsAttention(r, nowMs) ? 0 : r.shift_open ? 1 : 2);
  const name = (r: HealthRow) => localizedName(locale, r.full_name_en, r.full_name_ar);
  return [...rows].sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b), locale) || a.employee_id.localeCompare(b.employee_id));
}

// ---------------------------------------------------------------------------
// The device's own report
// ---------------------------------------------------------------------------

export const DEVICE_PERMISSIONS = ["granted", "denied", "prompt", "services_off", "unknown"] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];

/** What the browser's Permissions API says about geolocation, when it can be asked. */
export type BrowserPermissionState = "granted" | "denied" | "prompt" | null;

/**
 * The location permission as this device knows it:
 * - a refused permission or location switched off, seen by the collector, wins;
 * - in a browser, the Permissions API answer when there is one;
 * - otherwise a fix that arrived this shift means the permission is granted;
 * - else unknown (the native plugin has no "ask the permission" call the bridge allows).
 */
export function devicePermission(input: { problem: CollectorProblem | null; hasFix: boolean; browserState: BrowserPermissionState }): DevicePermission {
  if (input.problem === "denied") return "denied";
  if (input.problem === "services_off") return "services_off";
  if (input.browserState) return input.browserState;
  return input.hasFix ? "granted" : "unknown";
}

const VERSION = /^[0-9A-Za-z._+-]{1,40}$/;

/** A version or build id the server accepts, or null. */
export function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return VERSION.test(v) ? v : null;
}

/** The device-status payload (the whitelist of api.report_device_status, minus web_build: the server adds it). */
export interface DeviceStatusInput {
  source: PingSource;
  permission: DevicePermission;
  app_version: string | null;
  battery_saver: boolean | null;
  pending_points: number | null;
}

export function buildDeviceStatus(input: {
  native: boolean;
  problem: CollectorProblem | null;
  hasFix: boolean;
  browserState: BrowserPermissionState;
  appVersion: unknown;
  batterySaver: boolean | null;
  pendingPoints: number | null;
}): DeviceStatusInput {
  const pending = input.pendingPoints;
  return {
    source: input.native ? "native" : "pwa",
    permission: devicePermission(input),
    app_version: input.native ? cleanVersion(input.appVersion) : null,
    battery_saver: typeof input.batterySaver === "boolean" ? input.batterySaver : null,
    pending_points: typeof pending === "number" && Number.isFinite(pending) ? Math.min(100_000, Math.max(0, Math.floor(pending))) : null,
  };
}

/**
 * After a rate_limited answer: wait what the server said (plus a second of slack), within
 * 1 s .. 60 s, so one retry lands just after the minute.
 */
export function retryAfterMs(retryAfterS: unknown): number {
  const s = typeof retryAfterS === "number" && Number.isFinite(retryAfterS) ? retryAfterS : 60;
  return Math.min(60, Math.max(1, Math.ceil(s))) * 1000 + 1000;
}

/** The web build id the server reports (Vercel's commit sha, shortened), or null outside Vercel. */
export function webBuildId(env: Record<string, string | undefined>): string | null {
  return cleanVersion((env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 12)) ?? cleanVersion(env.VERCEL_DEPLOYMENT_ID ?? "");
}
